/**
 * Stamps givebutter_transaction_id, givebutter_reference_number, and
 * givebutter_is_recurring onto existing Zapier-created HubSpot deals that
 * were identified by the audit script as confirmed matches.
 *
 * Reads the audit JSON produced by audit-no-deal-candidates.mjs (v2) and the
 * original full CSV backup (which carries the recurring flag). For each
 * likely_exists result, finds the best strong-match deal and patches it.
 *
 * Runs dry by default. Pass --write to apply changes.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env \
 *     scripts/backfill-stamp-matched-deals.mjs [--write] [--out <file>]
 */

import { readFileSync, createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHubSpotClient } from "../src/lib/hubspot/client.ts";

const MANAGED_PIPELINE_IDS = new Set([
  "155504019", // Individual Donations
  "802960948", // Grant
  "806689671", // Sponsorships
]);

const AUDIT_JSON = "/private/tmp/claude-501/-Users-jimbaxley-Library-CloudStorage-Dropbox-Baxley-Consulting-Customer-Files-PORCH-CODE/92124d45-33b1-4ad0-be75-691780420008/scratchpad/no-deal-audit-v2.json";
const FULL_CSV   = "docs/no-deal-transactions-review.csv.bak-20260629";

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const writeMode = args.includes("--write");
const outIndex  = args.indexOf("--out");
const outFile   = outIndex !== -1 ? args[outIndex + 1] : null;
const mode      = writeMode ? "write" : "dry-run";

// ─── Load data ────────────────────────────────────────────────────────────────

const hubspot = createHubSpotClient();

console.error(`[stamp] mode=${mode}`);
console.error("[stamp] Loading audit results...");
const audit = JSON.parse(readFileSync(AUDIT_JSON, "utf8"));

console.error("[stamp] Loading original CSV for recurring flags...");
const csvByTxnId = await loadCsvByTransactionId(FULL_CSV);

// ─── Build work list ──────────────────────────────────────────────────────────

// Deduplicate by transaction ID — take the first strong match deal per transaction.
const seen = new Set();
const workItems = [];

for (const row of audit.results) {
  if (row.verdict !== "likely_exists") continue;
  if (seen.has(row.transactionId)) continue;
  seen.add(row.transactionId);

  const bestDeal = row.deals?.find((d) => d.strongMatch) ?? null;
  if (!bestDeal) continue;

  const csvRow = csvByTxnId.get(row.transactionId);

  workItems.push({
    transactionId:   row.transactionId,
    referenceNumber: row.reference ?? null,
    name:            row.name,
    date:            row.date,
    amount:          row.amount,
    isRecurring:     csvRow?.recurring === "yes",
    dealId:          bestDeal.dealId,
    dealName:        bestDeal.dealName,
    alreadyLinked:   bestDeal.alreadyLinked,
    pipeline:        bestDeal.pipeline,
  });
}

console.error(`[stamp] ${workItems.length} deals to stamp.`);

// ─── Process ──────────────────────────────────────────────────────────────────

const results = [];

for (const item of workItems) {
  results.push(await processItem(item));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const byStatus = {};
for (const r of results) {
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
}

const report = { generatedAt: new Date().toISOString(), mode, total: results.length, byStatus, results };
const output = JSON.stringify(report, null, 2);

if (outFile) {
  writeFileSync(outFile, output, "utf8");
  console.error(`[stamp] Report written to ${outFile}`);
} else {
  process.stdout.write(output + "\n");
}

console.error(`[stamp] Done. ${JSON.stringify(byStatus)}`);

// ─── Per-item logic ───────────────────────────────────────────────────────────

async function processItem(item) {
  const base = {
    transactionId:   item.transactionId,
    referenceNumber: item.referenceNumber,
    name:            item.name,
    amount:          item.amount,
    date:            item.date,
    dealId:          item.dealId,
    dealName:        item.dealName,
    isRecurring:     item.isRecurring,
  };

  // Guard: skip deals in unmanaged pipelines.
  if (item.pipeline && !MANAGED_PIPELINE_IDS.has(item.pipeline)) {
    return { ...base, status: "skipped_unmanaged_pipeline" };
  }

  // Guard: already has a Givebutter identifier — don't overwrite.
  if (item.alreadyLinked) {
    return { ...base, status: "already_linked" };
  }

  const properties = {};

  if (item.transactionId) {
    properties.givebutter_transaction_id = item.transactionId;
  }

  if (item.referenceNumber && /^\d+$/.test(item.referenceNumber)) {
    properties.givebutter_reference_number = item.referenceNumber;
  }

  if (item.isRecurring) {
    properties.givebutter_is_recurring = "true";
  }

  if (Object.keys(properties).length === 0) {
    return { ...base, status: "nothing_to_write" };
  }

  if (!writeMode) {
    return { ...base, status: "would_update", properties };
  }

  try {
    await hubspot.updateDeal(item.dealId, properties);
    return { ...base, status: "updated", properties };
  } catch (err) {
    return { ...base, status: "failed", error: err.message };
  }
}

// ─── CSV loader ───────────────────────────────────────────────────────────────

async function loadCsvByTransactionId(filePath) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const map = new Map();
  let headers = null;

  for await (const line of rl) {
    const cols = line.split(",");
    if (!headers) { headers = cols; continue; }
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cols[i] ?? "";
    if (row.transaction_id) map.set(row.transaction_id, row);
  }

  return map;
}
