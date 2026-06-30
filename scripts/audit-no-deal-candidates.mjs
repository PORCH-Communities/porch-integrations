/**
 * Audits "no deal found" Givebutter transactions from
 * docs/no-deal-transactions-review.csv to determine which ones
 * actually have an existing HubSpot deal (created by Zapier without
 * a givebutter_reference_number) vs. which are truly missing.
 *
 * For each transaction:
 *   1. Find the HubSpot contact by givebutter_contact_id, then email.
 *   2. Pull all deals associated to that contact (primary path).
 *   3. If none, search deals by last name token in dealname (fallback for
 *      Zapier deals that were never associated to a contact).
 *   4. Score each deal: amount match (±1%) + close date within 10 days + name match.
 *   5. Emit a verdict: likely_exists | ambiguous | truly_missing | no_contact
 *
 * Verdict definitions:
 *   likely_exists  — at least one deal matches amount + date + name
 *   ambiguous      — deals found but none match all three signals
 *   truly_missing  — contact found, no deals found at all
 *   no_contact     — no HubSpot contact found (safe to create)
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env scripts/audit-no-deal-candidates.mjs
 *   node --experimental-strip-types --env-file=.env scripts/audit-no-deal-candidates.mjs --out docs/no-deal-audit.json
 *
 * Read-only: makes no writes to HubSpot.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { createHubSpotClient } from "../src/lib/hubspot/client.ts";

const MANAGED_PIPELINE_IDS = new Set([
  "155504019", // Individual Donations
  "802960948", // Grant
  "806689671", // Sponsorships
]);

const DATE_WINDOW_DAYS = 10;
const AMOUNT_TOLERANCE = 0.01;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outFile = outIndex !== -1 ? args[outIndex + 1] : null;

const CSV_PATH = "docs/no-deal-transactions-review.csv";
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

// ─── Main ─────────────────────────────────────────────────────────────────────

const hubspot = createHubSpotClient();

console.error("[audit] Reading CSV...");
const rows = await readCsv(CSV_PATH);
console.error(`[audit] ${rows.length} transactions to audit.`);

const results = [];
let i = 0;

for (const row of rows) {
  i++;
  if (i % 20 === 0) console.error(`[audit] ${i}/${rows.length}...`);

  try {
    results.push(await auditRow(row));
  } catch (err) {
    results.push({
      date: row.date,
      reference: row.reference,
      transactionId: row.transaction_id,
      amount: row.amount,
      email: row.email || null,
      name: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
      contactId: row.contact_id || null,
      campaignCode: row.campaign_code || null,
      verdict: "error",
      error: err.message,
    });
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const byVerdict = {};
for (const r of results) {
  byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
}

const report = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  byVerdict,
  results,
};

const output = JSON.stringify(report, null, 2);

if (outFile) {
  writeFileSync(outFile, output, "utf8");
  console.error(`[audit] Written to ${outFile}`);
} else {
  process.stdout.write(output + "\n");
}

console.error("[audit] Done.");
console.error(`[audit] Summary: ${JSON.stringify(byVerdict)}`);

// ─── Per-row audit ────────────────────────────────────────────────────────────

async function auditRow(row) {
  const base = {
    date: row.date,
    reference: row.reference,
    transactionId: row.transaction_id,
    amount: row.amount,
    email: row.email || null,
    name: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
    contactId: row.contact_id || null,
    campaignCode: row.campaign_code || null,
  };

  // ── Step 1: find the HubSpot contact ────────────────────────────────────────

  let contact = null;

  if (row.contact_id) {
    const hits = await hubspot.searchContacts("givebutter_contact_id", row.contact_id, [
      "email",
      "firstname",
      "lastname",
      "givebutter_contact_id",
    ]);
    contact = hits[0] ?? null;
  }

  const safeEmail = row.email ? row.email.replace(/[^\w.@+\-]/g, "").trim() : null;

  if (!contact && safeEmail) {
    const hits = await hubspot.searchContacts("email", safeEmail, [
      "email",
      "firstname",
      "lastname",
      "givebutter_contact_id",
    ]);
    contact = hits[0] ?? null;
  }

  if (!contact) {
    return { ...base, verdict: "no_contact", hubspotContactId: null, deals: [] };
  }

  // ── Step 2: pull all deals associated to this contact ───────────────────────

  const DEAL_PROPERTIES = [
    "dealname",
    "amount",
    "closedate",
    "pipeline",
    "dealstage",
    "givebutter_reference_number",
    "givebutter_transaction_id",
  ];

  const dealMap = new Map();

  // Pass 1: deals already associated to the HubSpot contact.
  const associations = await hubspot.getDealContactAssociations(contact.id);
  const associatedDealIds = associations.map((a) => String(a.toObjectId));

  if (associatedDealIds.length > 0) {
    const fetched = await hubspot.getDeals(associatedDealIds, DEAL_PROPERTIES);
    for (const d of fetched) dealMap.set(d.id, d);
  }

  // Pass 2: name-based fallback — catches Zapier deals never associated to a contact.
  // Only run if Pass 1 found nothing, and only when we have a usable last name.
  const lastName = (row.last_name ?? "").trim();
  if (dealMap.size === 0 && lastName.length > 2) {
    const nameDeals = await searchDealsByName(lastName, DEAL_PROPERTIES);
    for (const d of nameDeals) {
      if (!dealMap.has(d.id)) dealMap.set(d.id, d);
    }
  }

  const dealObjects = [...dealMap.values()];

  if (dealObjects.length === 0) {
    return {
      ...base,
      verdict: "truly_missing",
      hubspotContactId: contact.id,
      hubspotContactName: [contact.properties.firstname, contact.properties.lastname]
        .filter(Boolean).join(" ") || null,
      deals: [],
    };
  }

  // ── Step 3: score each deal ──────────────────────────────────────────────────

  const txnAmount = Number(row.amount);
  const txnDate = new Date(row.date);
  const lastNameLower = lastName.toLowerCase();

  const scoredDeals = dealObjects.map((deal) => {
    const dealAmount = Number(deal.properties.amount ?? "NaN");
    const dealDate = deal.properties.closedate ? new Date(deal.properties.closedate) : null;
    const dealName = (deal.properties.dealname ?? "").toLowerCase();

    const amountMatch =
      Number.isFinite(txnAmount) &&
      Number.isFinite(dealAmount) &&
      dealAmount > 0 &&
      Math.abs(txnAmount - dealAmount) / dealAmount <= AMOUNT_TOLERANCE;

    const dateMatch =
      dealDate !== null &&
      !isNaN(dealDate) &&
      Math.abs(txnDate - dealDate) / 86_400_000 <= DATE_WINDOW_DAYS;

    const nameMatch = lastNameLower.length > 0 && dealName.includes(lastNameLower);

    const inManagedPipeline =
      deal.properties.pipeline ? MANAGED_PIPELINE_IDS.has(deal.properties.pipeline) : false;

    const alreadyLinked = Boolean(
      deal.properties.givebutter_reference_number?.trim() ||
      deal.properties.givebutter_transaction_id?.trim(),
    );

    return {
      dealId: deal.id,
      dealName: deal.properties.dealname ?? null,
      amount: deal.properties.amount ?? null,
      closedate: deal.properties.closedate ?? null,
      pipeline: deal.properties.pipeline ?? null,
      dealstage: deal.properties.dealstage ?? null,
      givebutter_reference_number: deal.properties.givebutter_reference_number ?? null,
      givebutter_transaction_id: deal.properties.givebutter_transaction_id ?? null,
      inManagedPipeline,
      alreadyLinked,
      amountMatch,
      dateMatch,
      nameMatch,
      strongMatch: amountMatch && dateMatch && nameMatch,
    };
  });

  // ── Step 4: verdict ──────────────────────────────────────────────────────────

  const strongMatches = scoredDeals.filter((d) => d.strongMatch);
  const verdict = strongMatches.length > 0 ? "likely_exists" : "ambiguous";

  return {
    ...base,
    verdict,
    hubspotContactId: contact.id,
    hubspotContactName: [
      contact.properties.firstname,
      contact.properties.lastname,
    ]
      .filter(Boolean)
      .join(" ") || null,
    strongMatchCount: strongMatches.length,
    totalDealCount: scoredDeals.length,
    deals: scoredDeals,
  };
}

// ─── HubSpot name search ──────────────────────────────────────────────────────

async function searchDealsByName(nameToken, properties) {
  const response = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: nameToken }],
        },
      ],
      properties,
      limit: 20,
    }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`HubSpot deal name search failed ${response.status}: ${body}`);
  }

  const body = await response.json();
  return body.results ?? [];
}

// ─── CSV reader ───────────────────────────────────────────────────────────────

async function readCsv(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  const rows = [];
  let headers = null;

  for await (const line of rl) {
    const cols = line.split(",");
    if (!headers) {
      headers = cols;
      continue;
    }
    const row = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cols[i] ?? "";
    }
    rows.push(row);
  }

  return rows;
}
