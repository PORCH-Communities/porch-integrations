/**
 * Fetches all Givebutter transactions, finds those with no matching HubSpot deal,
 * and prints a breakdown of why they might be missing.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env scripts/analyze-no-deal-transactions.mjs
 */

import { createHubSpotClient } from "../src/lib/hubspot/client.ts";

const GIVEBUTTER_API_BASE = "https://api.givebutter.com/v1";

const apiKey = process.env.GIVEBUTTER_API_KEY;
const hubspot = createHubSpotClient();

if (!apiKey) { console.error("GIVEBUTTER_API_KEY required"); process.exit(1); }

console.error("[analyze] Fetching all Givebutter transactions...");
const txns = await fetchAll();
console.error(`[analyze] Fetched ${txns.length}. Checking HubSpot deals...`);

const notFound = [];
let checked = 0;

for (const tx of txns) {
  const ref = String(tx.number ?? "").trim();
  if (!ref || !/^\d+$/.test(ref)) continue;

  const deals = await hubspot.searchDeals("givebutter_reference_number", ref, ["givebutter_reference_number", "pipeline"]);
  if (deals.length === 0) {
    notFound.push(tx);
  }

  checked++;
  if (checked % 50 === 0) console.error(`[analyze] ${checked}/${txns.length} checked, ${notFound.length} not found so far...`);
}

console.error(`[analyze] Done. ${notFound.length} transactions have no HubSpot deal.`);

// ─── Analysis ─────────────────────────────────────────────────────────────────

const byStatus     = bucket(notFound, (t) => t.status ?? "unknown");
const byMethod     = bucket(notFound, (t) => t.method ?? "unknown");
const byOffline    = bucket(notFound, (t) => t.is_offline ? "offline" : "online");
const byRecurring  = bucket(notFound, (t) => t.is_recurring ? "recurring" : "one_time");
const byHasEmail   = bucket(notFound, (t) => t.email ? "has_email" : "no_email");
const byHasName    = bucket(notFound, (t) => (t.first_name || t.last_name) ? "has_name" : "no_name");
const byCompany    = bucket(notFound, (t) => t.company_name ? "company_gift" : "individual");
const byCampaign   = bucket(notFound, (t) => t.campaign_code ?? "no_campaign_code");

// Date distribution — by month
const byMonth = bucket(notFound, (t) => {
  const d = t.created_at ?? t.transacted_at ?? "";
  return d.slice(0, 7) || "unknown"; // YYYY-MM
});

// Amount bands
const byAmountBand = bucket(notFound, (t) => {
  const amt = Number(t.amount ?? 0);
  if (amt === 0)    return "$0";
  if (amt < 25)     return "<$25";
  if (amt < 100)    return "$25–$99";
  if (amt < 500)    return "$100–$499";
  if (amt < 1000)   return "$500–$999";
  return "$1000+";
});

const report = {
  total: notFound.length,
  byStatus:     sortDesc(byStatus),
  byMethod:     sortDesc(byMethod),
  byOffline:    sortDesc(byOffline),
  byRecurring:  sortDesc(byRecurring),
  byHasEmail:   sortDesc(byHasEmail),
  byHasName:    sortDesc(byHasName),
  byCompany:    sortDesc(byCompany),
  byAmountBand: sortDesc(byAmountBand),
  byCampaignCode: sortDesc(byCampaign),
  byMonth:      Object.fromEntries(Object.entries(byMonth).sort()),
};

console.log(JSON.stringify(report, null, 2));

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAll() {
  const all = [];
  let page = 1;
  while (true) {
    const url = new URL(`${GIVEBUTTER_API_BASE}/transactions`);
    url.searchParams.set("limit", "25");
    url.searchParams.set("page", String(page));
    const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` } });
    const body = await res.json();
    const batch = Array.isArray(body.data) ? body.data : [];
    if (!batch.length) break;
    all.push(...batch);
    const lastPage = body.meta?.last_page ?? 1;
    if (!body.links?.next || page >= lastPage) break;
    page++;
  }
  return all;
}

function bucket(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function sortDesc(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([, a], [, b]) => b - a));
}
