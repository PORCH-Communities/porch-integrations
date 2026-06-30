/**
 * Audits and backfills recurring gift metadata on historical HubSpot deals.
 *
 * Dry-run by default. Pass --write to apply. Historical updates always set
 * suppress_automated_communications=true so a backfill cannot send email.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env \
 *     scripts/backfill-recurring-deals.mjs [--write] [--days 3650] [--limit 10000] [--out report.json]
 */

import { writeFileSync } from "node:fs";

import { mapGivebutterDonation } from "../src/lib/givebutter/payloads.ts";
import { createHubSpotClient } from "../src/lib/hubspot/client.ts";
import { resolveRecurringCommunication } from "../src/lib/hubspot/recurring-gifts.ts";

const GIVEBUTTER_API_BASE = "https://api.givebutter.com/v1";
const MANAGED_PIPELINES = new Set(["155504019", "802960948", "806689671"]);
const DEAL_PROPERTIES = [
  "pipeline",
  "givebutter_transaction_id",
  "givebutter_reference_number",
  "givebutter_plan_id",
  "givebutter_is_recurring",
  "recurring_communication_type",
  "recurring_anniversary_number",
  "recurring_plan_start_date",
  "suppress_automated_communications",
];

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.GIVEBUTTER_API_KEY;
const hubspot = createHubSpotClient();

if (!apiKey) {
  throw new Error("GIVEBUTTER_API_KEY must be set.");
}

console.error(
  `[recurring-backfill] mode=${args.write ? "write" : "dry-run"} days=${args.days} limit=${args.limit}`,
);

const fetchResult = await fetchTransactions(apiKey, args.days, args.limit);
const rawTransactions = fetchResult.transactions;

if (args.write && !fetchResult.historyComplete) {
  throw new Error(
    `Refusing --write because transaction history is incomplete (${fetchResult.stopReason}). Increase --days/--limit and rerun.`,
  );
}
const donations = rawTransactions
  .map((raw) => mapGivebutterDonation({ id: raw.id, event: "transaction.succeeded", data: raw }))
  .filter(
    (donation) =>
      donation.isRecurring &&
      donation.planId !== null &&
      (!donation.status || donation.status === "succeeded"),
  );
const classified = await classifyByPlan(donations);

console.error(
  `[recurring-backfill] fetched=${rawTransactions.length} recurring=${classified.length}. Reconciling HubSpot...`,
);

const results = [];

for (const item of classified) {
  results.push(await reconcile(item));

  if (results.length % 25 === 0) {
    console.error(`[recurring-backfill] ${results.length}/${classified.length} processed...`);
  }
}

const summary = Object.fromEntries(
  [...new Set(results.map((result) => result.status))]
    .sort()
    .map((status) => [status, results.filter((result) => result.status === status).length]),
);
const report = {
  generatedAt: new Date().toISOString(),
  mode: args.write ? "write" : "dry-run",
  fetchedTransactions: rawTransactions.length,
  recurringTransactions: classified.length,
  distinctPlans: new Set(classified.map((item) => String(item.donation.planId))).size,
  historyComplete: fetchResult.historyComplete,
  stopReason: fetchResult.stopReason,
  summary,
  results,
};
const output = JSON.stringify(report, null, 2);

if (args.out) {
  writeFileSync(args.out, output, "utf8");
  console.error(`[recurring-backfill] report=${args.out}`);
} else {
  process.stdout.write(`${output}\n`);
}

if (results.some((result) => result.status === "failed")) {
  process.exitCode = 1;
}

async function classifyByPlan(allDonations) {
  const groups = new Map();

  for (const donation of allDonations) {
    const planId = String(donation.planId);
    const group = groups.get(planId) ?? [];
    group.push(donation);
    groups.set(planId, group);
  }

  const classifiedItems = [];

  for (const donationsInPlan of groups.values()) {
    donationsInPlan.sort((left, right) => transactionDate(left).localeCompare(transactionDate(right)));
    const priorDeals = [];

    for (const donation of donationsInPlan) {
      const communication = await resolveRecurringCommunication(
        { async searchDeals() { return priorDeals; } },
        donation,
      );

      if (!communication) continue;

      classifiedItems.push({ donation, communication });
      priorDeals.push({
        id: String(donation.transactionId ?? donation.transactionNumber),
        properties: {
          closedate: transactionDate(donation),
          givebutter_transaction_id: String(donation.transactionId ?? ""),
          recurring_communication_type: communication.type,
          recurring_anniversary_number:
            communication.anniversaryNumber === null
              ? null
              : String(communication.anniversaryNumber),
          recurring_plan_start_date: communication.planStartDate,
        },
      });
    }
  }

  return classifiedItems.sort((left, right) =>
    transactionDate(left.donation).localeCompare(transactionDate(right.donation)),
  );
}

async function reconcile({ donation, communication }) {
  const transactionId = String(donation.transactionId ?? "").trim();
  const referenceNumber = String(donation.transactionNumber ?? "").trim();
  const base = {
    transactionId: mask(transactionId),
    referenceNumber: mask(referenceNumber),
    planId: mask(String(donation.planId)),
    transactionDate: transactionDate(donation),
    communicationType: communication.type,
    anniversaryNumber: communication.anniversaryNumber,
  };

  try {
    const deal = await findDeal(transactionId, referenceNumber);

    if (!deal) {
      return { ...base, status: "deal_not_found" };
    }

    if (deal.properties.pipeline && !MANAGED_PIPELINES.has(deal.properties.pipeline)) {
      return { ...base, dealId: deal.id, status: "skipped_pipeline" };
    }

    const existingPlanId = deal.properties.givebutter_plan_id?.trim() || null;
    const planId = String(donation.planId);

    if (existingPlanId && existingPlanId !== planId) {
      return { ...base, dealId: deal.id, status: "plan_id_conflict" };
    }

    const desired = {
      givebutter_transaction_id: transactionId,
      givebutter_plan_id: planId,
      givebutter_is_recurring: "true",
      recurring_communication_type: communication.type,
      recurring_anniversary_number:
        communication.anniversaryNumber === null
          ? ""
          : String(communication.anniversaryNumber),
      recurring_plan_start_date: communication.planStartDate,
      // Historical writes must never enroll in a donor communication workflow.
      suppress_automated_communications: "true",
    };
    const changedProperties = Object.fromEntries(
      Object.entries(desired).filter(
        ([property, value]) => (deal.properties[property] ?? "") !== value,
      ),
    );

    if (Object.keys(changedProperties).length === 0) {
      return { ...base, dealId: deal.id, status: "already_current" };
    }

    if (!args.write) {
      return {
        ...base,
        dealId: deal.id,
        status: "would_update",
        changedProperties: Object.keys(changedProperties),
      };
    }

    await hubspot.updateDeal(deal.id, changedProperties);

    return {
      ...base,
      dealId: deal.id,
      status: "updated",
      changedProperties: Object.keys(changedProperties),
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function findDeal(transactionId, referenceNumber) {
  if (transactionId) {
    const byTransaction = await hubspot.searchDeals(
      "givebutter_transaction_id",
      transactionId,
      DEAL_PROPERTIES,
    );

    if (byTransaction[0]) return byTransaction[0];
  }

  if (/^\d+$/.test(referenceNumber)) {
    const byReference = await hubspot.searchDeals(
      "givebutter_reference_number",
      referenceNumber,
      DEAL_PROPERTIES,
    );

    if (byReference[0]) return byReference[0];
  }

  return null;
}

async function fetchTransactions(key, days, limit) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const all = [];
  let page = 1;

  while (all.length < limit) {
    const url = new URL(`${GIVEBUTTER_API_BASE}/transactions`);
    url.searchParams.set("limit", "25");
    url.searchParams.set("page", String(page));
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      throw new Error(`Givebutter API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }

    const body = await response.json();
    const batch = Array.isArray(body.data) ? body.data : [];

    if (batch.length === 0) break;

    for (const transaction of batch) {
      const date = String(transaction.transacted_at ?? transaction.created_at ?? "").slice(0, 10);

      if (date && date < cutoffDate) {
        return { transactions: all, historyComplete: false, stopReason: "date_cutoff" };
      }
      all.push(transaction);
      if (all.length >= limit) {
        return { transactions: all, historyComplete: false, stopReason: "limit" };
      }
    }

    const lastPage = body.meta?.last_page ?? null;
    if ((lastPage !== null && page >= lastPage) || !body.links?.next) {
      return { transactions: all, historyComplete: true, stopReason: "end_of_history" };
    }
    if (page % 5 === 0) {
      console.error(`[recurring-backfill] fetched page ${page} (${all.length} transactions)...`);
    }
    page += 1;
  }

  return { transactions: all, historyComplete: true, stopReason: "end_of_history" };
}

function transactionDate(donation) {
  return String(donation.transactedAt ?? donation.createdAt ?? "").slice(0, 10);
}

function mask(value) {
  return value.length <= 4 ? "****" : `***${value.slice(-4)}`;
}

function parseArgs(argv) {
  const parsed = { write: false, days: 3650, limit: 10_000, out: null };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--write") parsed.write = true;
    else if (argument === "--days") parsed.days = Number(argv[++index]);
    else if (argument === "--limit") parsed.limit = Number(argv[++index]);
    else if (argument === "--out") parsed.out = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!Number.isInteger(parsed.days) || parsed.days < 1) throw new Error("--days must be positive");
  if (!Number.isInteger(parsed.limit) || parsed.limit < 1) throw new Error("--limit must be positive");

  return parsed;
}
