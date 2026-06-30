/**
 * Backfills givebutter_transaction_id onto existing HubSpot deals.
 *
 * Fetches all Givebutter transactions, finds the matching HubSpot deal by
 * givebutter_reference_number, and writes givebutter_transaction_id if it is
 * currently blank. Required before refund reconciliation can work — refund.created
 * events match to deals via transaction_id, not reference number.
 *
 * Runs dry by default. Pass --write to apply changes.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-transaction-ids.mjs [options]
 *
 * Options:
 *   --write             Apply changes to HubSpot (default: dry run)
 *   --days <n>          Lookback window in days (default: 730 / ~2 years)
 *   --limit <n>         Cap on Givebutter transactions to process (default: 2000)
 *   --concurrency <n>   Parallel HubSpot lookups (default: 4, max: 8)
 *   --out <file>        Write JSON report to a file instead of stdout
 */

import { writeFileSync } from "node:fs";
import { createHubSpotClient } from "../src/lib/hubspot/client.ts";

const GIVEBUTTER_API_BASE = "https://api.givebutter.com/v1";
// Only stamp transaction IDs on deals in these managed pipelines.
// Prevents touching staff-managed or archived deals in other pipelines.
const MANAGED_PIPELINE_IDS = new Set([
  "155504019", // Individual Donations
  "802960948", // Grant
  "806689671", // Sponsorships
]);

// ─── Entry point ──────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const givebutterApiKey = process.env.GIVEBUTTER_API_KEY;
const hubspotClient = createHubSpotClient();

// HubSpot Starter enforces a per-second search limit. With concurrency=2 and
// one search call per transaction, we stay well under the secondly threshold.
// Raise only if the portal is on a higher tier with a relaxed search quota.

if (!givebutterApiKey) {
  console.error("GIVEBUTTER_API_KEY must be set.");
  process.exit(1);
}

const mode = args.write ? "write" : "dry-run";
console.error(`[backfill] mode=${mode} days=${args.days} limit=${args.limit} concurrency=${args.concurrency}`);
console.error(`[backfill] Fetching Givebutter transactions...`);

const transactions = await fetchAllTransactions(givebutterApiKey, args.days, args.limit);
console.error(`[backfill] Fetched ${transactions.length} transactions. Processing...`);

const results = await processConcurrently(transactions, processTransaction, args.concurrency);

const summary = {
  total: results.length,
  updated: results.filter((r) => r.status === "updated").length,
  wouldUpdate: results.filter((r) => r.status === "would_update").length,
  alreadySet: results.filter((r) => r.status === "already_set").length,
  dealNotFound: results.filter((r) => r.status === "deal_not_found").length,
  noReferenceNumber: results.filter((r) => r.status === "no_reference_number").length,
  skippedPipeline: results.filter((r) => r.status === "skipped_pipeline").length,
  testTransaction: results.filter((r) => r.status === "test_transaction").length,
  failed: results.filter((r) => r.status === "failed").length,
};

const report = {
  generatedAt: new Date().toISOString(),
  mode,
  parameters: { days: args.days, limit: args.limit, concurrency: args.concurrency },
  summary,
  results,
};

const output = JSON.stringify(report, null, 2);

if (args.out) {
  writeFileSync(args.out, output, "utf8");
  console.error(`[backfill] Report written to ${args.out}`);
} else {
  process.stdout.write(output + "\n");
}

if (summary.failed > 0) {
  process.exit(1);
}

// ─── Per-transaction processing ───────────────────────────────────────────────

async function processTransaction(tx) {
  const transactionId = String(tx.id ?? "").trim();
  const referenceNumber = String(tx.number ?? "").trim();
  const maskedRef = maskIdentifier(referenceNumber);
  const maskedTxId = maskIdentifier(transactionId);

  if (!transactionId || transactionId === "0") {
    return { referenceNumber: maskedRef, transactionId: maskedTxId, status: "test_transaction" };
  }

  if (isTestTransaction(tx)) {
    return { referenceNumber: maskedRef, transactionId: maskedTxId, status: "test_transaction" };
  }

  if (!referenceNumber || !/^\d+$/.test(referenceNumber)) {
    return { referenceNumber: maskedRef, transactionId: maskedTxId, status: "no_reference_number" };
  }

  let deals;
  try {
    deals = await hubspotClient.searchDeals(
      "givebutter_reference_number",
      referenceNumber,
      ["givebutter_transaction_id", "givebutter_reference_number", "pipeline", "dealstage"],
    );
  } catch (err) {
    return { referenceNumber: maskedRef, transactionId: maskedTxId, status: "failed", error: err.message };
  }

  if (deals.length === 0) {
    return { referenceNumber: maskedRef, transactionId: maskedTxId, status: "deal_not_found" };
  }

  // Only touch the first match; warn if multiple deals share the same reference number.
  const deal = deals[0];
  const multipleDeals = deals.length > 1;

  if (deal.properties.pipeline && !MANAGED_PIPELINE_IDS.has(deal.properties.pipeline)) {
    return {
      referenceNumber: maskedRef,
      transactionId: maskedTxId,
      dealId: deal.id,
      pipeline: deal.properties.pipeline,
      status: "skipped_pipeline",
    };
  }

  const existingTxId = deal.properties.givebutter_transaction_id?.trim() || null;

  if (existingTxId) {
    return {
      referenceNumber: maskedRef,
      transactionId: maskedTxId,
      dealId: deal.id,
      status: "already_set",
      existingTransactionId: maskIdentifier(existingTxId),
      conflict: existingTxId !== transactionId ? true : undefined,
    };
  }

  if (!args.write) {
    return {
      referenceNumber: maskedRef,
      transactionId: maskedTxId,
      dealId: deal.id,
      status: "would_update",
      multipleDeals: multipleDeals || undefined,
    };
  }

  try {
    await hubspotClient.updateDeal(deal.id, { givebutter_transaction_id: transactionId });
    return {
      referenceNumber: maskedRef,
      transactionId: maskedTxId,
      dealId: deal.id,
      status: "updated",
      multipleDeals: multipleDeals || undefined,
    };
  } catch (err) {
    return {
      referenceNumber: maskedRef,
      transactionId: maskedTxId,
      dealId: deal.id,
      status: "failed",
      error: err.message,
    };
  }
}

// ─── Givebutter API ───────────────────────────────────────────────────────────

async function fetchAllTransactions(apiKey, days, limit) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const all = [];
  let page = 1;

  while (all.length < limit) {
    const url = new URL(`${GIVEBUTTER_API_BASE}/transactions`);
    url.searchParams.set("limit", "25");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Givebutter API ${response.status}: ${text.slice(0, 500)}`);
    }

    const body = await response.json();
    const batch = Array.isArray(body.data) ? body.data : [];

    if (batch.length === 0) break;

    for (const tx of batch) {
      const createdAt = tx.created_at ?? tx.transacted_at ?? null;
      if (createdAt && createdAt < cutoffIso) return all;
      all.push(tx);
      if (all.length >= limit) break;
    }

    const lastPage = body.meta?.last_page ?? null;
    if (lastPage !== null && page >= lastPage) break;
    if (!body.links?.next) break;

    if (page % 5 === 0) {
      console.error(`[backfill] Fetched page ${page} (${all.length} total)...`);
    }
    page += 1;
  }

  return all;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function isTestTransaction(tx) {
  const id = String(tx.id ?? "").toLowerCase();
  const code = String(tx.campaign_code ?? "").toUpperCase();
  return id === "test" || id.startsWith("api-sample-") || code === "SAMPLE";
}

function maskIdentifier(value) {
  const s = String(value ?? "");
  if (s.length <= 4) return "****";
  return `***${s.slice(-4)}`;
}

async function processConcurrently(items, fn, concurrency) {
  const results = [];
  const queue = [...items];
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        results.push(await fn(item));
      } catch (err) {
        results.push({
          referenceNumber: maskIdentifier(String(item.number ?? "")),
          transactionId: maskIdentifier(String(item.id ?? "")),
          status: "failed",
          error: err.message,
        });
      }
      completed += 1;
      if (completed % 25 === 0) {
        console.error(`[backfill] ${completed}/${items.length} processed...`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return results;
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { write: false, days: 730, limit: 2000, concurrency: 2, out: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--write") { opts.write = true; continue; }

    if (arg === "--days")        { opts.days        = clamp(Number(argv[++i]), 1, 3650); continue; }
    if (arg === "--limit")       { opts.limit       = clamp(Number(argv[++i]), 1, 5000); continue; }
    if (arg === "--concurrency") { opts.concurrency = clamp(Number(argv[++i]), 1, 4);    continue; }
    if (arg === "--out")         { opts.out         = argv[++i]; continue; }

    if (arg.startsWith("--days="))        { opts.days        = clamp(Number(arg.slice(7)),  1, 3650); continue; }
    if (arg.startsWith("--limit="))       { opts.limit       = clamp(Number(arg.slice(8)),  1, 5000); continue; }
    if (arg.startsWith("--concurrency=")) { opts.concurrency = clamp(Number(arg.slice(14)), 1, 4);    continue; }
    if (arg.startsWith("--out="))         { opts.out         = arg.slice(6); continue; }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
