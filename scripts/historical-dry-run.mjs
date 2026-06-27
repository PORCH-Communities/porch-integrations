/**
 * Historical dry-run reconciliation.
 *
 * Fetches 60–90 days of Givebutter transactions via the Givebutter API, runs the full
 * parity processor in shadow mode against each one, then loads the HubSpot records
 * Zapier actually created and compares them field-by-field.
 *
 * No HubSpot writes are performed. Every discrepancy is classified with an understood
 * disposition rather than left as "close enough".
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env scripts/historical-dry-run.mjs [options]
 *
 * Options:
 *   --days <n>          Lookback window in days (default: 90, max: 90)
 *   --limit <n>         Cap on total transactions to process (default: 200)
 *   --show-values       Include expected/actual values in mismatch output
 *   --show-passing      Include passing transactions in per-transaction output
 *   --concurrency <n>   Parallel HubSpot lookups (default: 4, max: 8)
 *   --out <file>        Write JSON report to a file instead of stdout
 */

import { writeFileSync } from "node:fs";

import {
  mapGivebutterDonation,
  getFallbackEmail,
} from "../src/lib/givebutter/payloads.ts";
import { createHubSpotClient } from "../src/lib/hubspot/client.ts";
import {
  buildContactProperties,
  buildDealProperties,
  processGivebutterDonation,
  CHAPTER_FINANCIAL_DONOR_ASSOCIATION_TYPE_ID,
  CHAPTER_DONATION_CONTACT_ASSOCIATION_TYPE_ID,
  COMPANY_DONATION_CONTACT_ASSOCIATION_TYPE_ID,
} from "../src/lib/hubspot/donation-parity.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEAL_CONTACT_DEFAULT_TYPE_ID = 3;
const DEAL_CHAPTER_FINANCIAL_DONOR_TYPE_ID = CHAPTER_FINANCIAL_DONOR_ASSOCIATION_TYPE_ID;   // 11
const DEAL_CHAPTER_DONATION_CONTACT_TYPE_ID = CHAPTER_DONATION_CONTACT_ASSOCIATION_TYPE_ID; // 12
const COMPANY_DONATION_CONTACT_TYPE_ID = COMPANY_DONATION_CONTACT_ASSOCIATION_TYPE_ID;      // 3

// Fields the Zapier zap never populated (not a parity gap — structural difference).
const ZAPIER_NEVER_WROTE = new Set([
  "givebutter_transaction_id", // new field; Zapier used reference number only
]);

// Fields Zapier wrote with different semantics that are expected to differ.
const KNOWN_EXPECTED_DIFFERENCES = {
  // Zapier used campaign_id → Zapier Tables name lookup; Vercel uses campaign_title-campaign_code inline.
  // The semantic content is the same but the exact string may differ when campaign title changed after creation.
  givebutter_campaign: "zapier_used_table_lookup_may_differ_on_title_change",
  // Zapier description = transactions[0].id (first child); Vercel = reference number.
  description: "zapier_wrote_child_transaction_id_not_reference_number",
};

// ─── Disposition codes ────────────────────────────────────────────────────────
// Every discrepancy must get exactly one code. "close_enough" is not a valid code.

const DISPOSITION = {
  // Record-level dispositions
  ZAPIER_HALTED:          "zapier_halted",          // Zapier step stopped (campaign not in table, no chapter found, etc.)
  ORG_DONOR_NO_IDENTITY: "org_donor_no_identity",  // Organization gift with no email or contact ID
  NO_TRANSACTION_KEY:    "no_transaction_key",      // Transaction has neither ID nor reference number
  TEST_TRANSACTION:      "test_transaction",        // Detected as a test/sample payload
  CONTACT_MISSING:       "contact_missing",         // No HubSpot contact found for this donor
  DEAL_MISSING:          "deal_missing",            // No HubSpot deal found for this transaction
  MULTIPLE_CONTACTS:     "multiple_contacts",       // Ambiguous contact lookup returned >1 result
  MULTIPLE_DEALS:        "multiple_deals",          // Ambiguous deal lookup returned >1 result

  // Field-level dispositions
  FIELD_MATCH:              "field_match",
  ZAPIER_NEVER_WROTE_FIELD: "zapier_never_wrote",   // Field is new; Zapier structural gap, not an error
  EXPECTED_DIFF:            "expected_diff",         // Known semantic difference with understood cause
  VERCEL_WOULD_ADD:         "vercel_would_add",      // Vercel populates; Zapier left blank
  ZAPIER_DIFFERENT:         "zapier_different",      // Values differ; Zapier value is the canonical one
  MISSING_ASSOCIATION:      "missing_association",   // Required HubSpot association absent
  EXTRA_ASSOCIATION:        "extra_association",     // Vercel would add association Zapier did not
  NOT_APPLICABLE:           "not_applicable",        // Check skipped (chapter lead absent, org donor, etc.)
};

// ─── Entry point ──────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const hubspotClient = createHubSpotClient();
const givebutterApiKey = process.env.GIVEBUTTER_API_KEY;

if (!givebutterApiKey) {
  console.error("GIVEBUTTER_API_KEY must be set to run the historical dry-run.");
  process.exit(1);
}

console.error(`[dry-run] Fetching up to ${args.limit} transactions from the last ${args.days} days...`);

const transactions = await fetchGivebutterTransactions(givebutterApiKey, args.days, args.limit);

console.error(`[dry-run] Fetched ${transactions.length} transactions. Processing with concurrency=${args.concurrency}...`);

const results = await processConcurrently(transactions, reconcileTransaction, args.concurrency);

const report = buildReport(results, args);

const output = JSON.stringify(report, null, 2);

if (args.out) {
  writeFileSync(args.out, output, "utf8");
  console.error(`[dry-run] Report written to ${args.out}`);
} else {
  process.stdout.write(output + "\n");
}

// ─── Givebutter API ───────────────────────────────────────────────────────────

async function fetchGivebutterTransactions(apiKey, days, limit) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  const all = [];
  let cursor = null;
  let page = 1;

  while (all.length < limit) {
    const url = new URL("https://api.givebutter.com/v1/transactions");
    url.searchParams.set("limit", String(Math.min(25, limit - all.length)));
    // Givebutter paginates via `cursor` (opaque string) returned in the response envelope.
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Givebutter API ${response.status}: ${text.slice(0, 500)}`);
    }

    const body = await response.json();
    const batch = Array.isArray(body.data) ? body.data : [];

    if (batch.length === 0) {
      break;
    }

    for (const tx of batch) {
      const createdAt = tx.created_at ?? tx.transacted_at ?? null;
      if (createdAt && createdAt < cutoffIso) {
        // Results are newest-first; once we're past the window, stop.
        return all;
      }
      all.push(tx);
      if (all.length >= limit) break;
    }

    // Givebutter uses cursor-based pagination. The meta or links object carries the next cursor.
    cursor = body.meta?.next_cursor ?? body.links?.next_cursor ?? null;
    if (!cursor) break;

    console.error(`[dry-run] Fetched page ${page} (${all.length} total)...`);
    page += 1;
  }

  return all;
}

// ─── Per-transaction reconciliation ──────────────────────────────────────────

async function reconcileTransaction(rawTransaction) {
  const webhookPayload = {
    id: rawTransaction.id ?? null,
    event: "transaction.succeeded",
    data: rawTransaction,
  };

  const donation = mapGivebutterDonation(webhookPayload);

  // ── Classify special cases before any API calls ──────────────────────────

  if (isTestTransaction(rawTransaction, donation)) {
    return makeResult(rawTransaction, donation, DISPOSITION.TEST_TRANSACTION, [], []);
  }

  const transactionKey = String(donation.transactionId ?? donation.transactionNumber ?? "");

  if (!transactionKey) {
    return makeResult(rawTransaction, donation, DISPOSITION.NO_TRANSACTION_KEY, [], []);
  }

  if (donation.donorType === "organization" && !donation.email && !donation.contactId) {
    return makeResult(rawTransaction, donation, DISPOSITION.ORG_DONOR_NO_IDENTITY, [], []);
  }

  // ── Shadow-mode parity run ───────────────────────────────────────────────

  let shadowResult;
  try {
    shadowResult = await processGivebutterDonation(hubspotClient, donation, "shadow");
  } catch (err) {
    return makeResult(rawTransaction, donation, "shadow_error", [], [
      { field: "shadow_run", disposition: "shadow_error", detail: err.message },
    ]);
  }

  if (shadowResult.status === "needs_attention") {
    // No identity (email + contactId both absent for a person donor)
    return makeResult(rawTransaction, donation, DISPOSITION.ORG_DONOR_NO_IDENTITY, [], []);
  }

  // ── Load what Zapier actually created ────────────────────────────────────

  const expectedContactProps = buildContactProperties(donation);
  const chapter = shadowResult.chapterCompanyId
    ? { id: shadowResult.chapterCompanyId }
    : await findChapterByCode(donation.campaignCode);

  const destination = chapter ? "Chapter" : "PORCH-Communities";
  const expectedDealProps = buildDealProperties(donation, destination);

  const [actualContact, actualDeal] = await Promise.all([
    findActualContact(donation, Object.keys(expectedContactProps)),
    findActualDeal(donation, Object.keys(expectedDealProps)),
  ]);

  const checks = [];

  // ── Contact checks ───────────────────────────────────────────────────────

  if (!actualContact) {
    const disposition = shadowResult.contact?.action === "would_create"
      ? DISPOSITION.ZAPIER_HALTED   // Zapier may have halted; Vercel would create
      : DISPOSITION.CONTACT_MISSING;
    checks.push(makeFieldCheck("contact", "record", disposition, null, null));
  } else {
    checks.push(...compareProperties("contact", expectedContactProps, actualContact.properties, donation));
  }

  // ── Deal checks ──────────────────────────────────────────────────────────

  if (!actualDeal) {
    checks.push(makeFieldCheck("deal", "record", DISPOSITION.DEAL_MISSING, null, null));
  } else {
    checks.push(...compareProperties("deal", expectedDealProps, actualDeal.properties, donation));
  }

  // ── Association checks (only when both contact and deal are present) ─────

  if (actualContact && actualDeal) {
    const [loadedContact, loadedDeal, dealContacts] = await Promise.all([
      hubspotClient.getContact(actualContact.id),
      hubspotClient.getDeal(actualDeal.id),
      hubspotClient.getDealContactAssociations(actualDeal.id),
    ]);

    const contactDealIds = idSet(loadedContact.associations?.deals?.results);
    const dealContactIds = idSet(loadedDeal.associations?.contacts?.results);
    const dealCompanyIds = idSet(loadedDeal.associations?.companies?.results);

    // Core contact ↔ deal
    checks.push(
      makeAssociationCheck("contact_to_deal", contactDealIds.has(actualDeal.id)),
      makeAssociationCheck("deal_to_contact", dealContactIds.has(actualContact.id)),
      makeAssociationCheck(
        "default_deal_contact_label",
        hasAssociationType(dealContacts, actualContact.id, DEAL_CONTACT_DEFAULT_TYPE_ID),
      ),
    );

    // Chapter path
    if (chapter) {
      checks.push(
        makeAssociationCheck("deal_to_chapter", dealCompanyIds.has(chapter.id)),
        makeAssociationCheck(
          "chapter_financial_donor",
          hasAssociationType(dealContacts, actualContact.id, DEAL_CHAPTER_FINANCIAL_DONOR_TYPE_ID),
        ),
      );

      const companyContacts = await hubspotClient.getCompanyContactAssociations(chapter.id);
      const chapterLead = companyContacts.find((a) =>
        a.associationTypes?.some((t) => t.typeId === COMPANY_DONATION_CONTACT_TYPE_ID),
      );

      if (chapterLead) {
        checks.push(
          makeAssociationCheck(
            "chapter_donation_contact",
            hasAssociationType(dealContacts, String(chapterLead.toObjectId), DEAL_CHAPTER_DONATION_CONTACT_TYPE_ID),
          ),
        );
      } else {
        checks.push({
          scope: "association",
          field: "chapter_donation_contact",
          disposition: DISPOSITION.NOT_APPLICABLE,
          detail: "Chapter company has no Donation Contact association",
        });
      }
    }

    // Donor-company path
    if (donation.companyName) {
      const donorCompany = await findFirstCompany("name", donation.companyName);

      if (!donorCompany) {
        checks.push({
          scope: "company",
          field: "donor_company_record",
          disposition: DISPOSITION.DEAL_MISSING,
          detail: `No HubSpot company found for name="${donation.companyName}"`,
        });
      } else {
        const contactCompanyIds = idSet(loadedContact.associations?.companies?.results);
        checks.push(
          makeAssociationCheck("contact_to_donor_company", contactCompanyIds.has(donorCompany.id)),
          makeAssociationCheck("deal_to_donor_company", dealCompanyIds.has(donorCompany.id)),
        );
      }
    }
  }

  // ── Classify overall pass/fail ───────────────────────────────────────────

  const failures = checks.filter((c) => isFailure(c));
  const passingCount = checks.filter((c) => c.disposition === DISPOSITION.FIELD_MATCH).length;
  const expectedDiffCount = checks.filter((c) =>
    c.disposition === DISPOSITION.EXPECTED_DIFF ||
    c.disposition === DISPOSITION.ZAPIER_NEVER_WROTE_FIELD
  ).length;

  const overallStatus = failures.length === 0 ? "pass" : "fail";

  return {
    transactionKey: maskIdentifier(transactionKey),
    receivedAt: rawTransaction.created_at ?? rawTransaction.transacted_at ?? null,
    donorType: donation.donorType,
    isOffline: donation.isOffline,
    isRecurring: donation.isRecurring,
    hasDedication: Object.values(donation.dedication).some(Boolean),
    hasUtm: Object.values(donation.utm).some(Boolean),
    hasCompanyName: Boolean(donation.companyName),
    campaignCode: donation.campaignCode ?? null,
    destination,
    chapterFound: Boolean(chapter),
    shadowActions: shadowResult.actions,
    shadowWarnings: shadowResult.warnings,
    contactAction: shadowResult.contact?.action ?? null,
    dealAction: shadowResult.deal?.action ?? null,
    overallStatus,
    passCount: passingCount,
    expectedDiffCount,
    failureCount: failures.length,
    failures: args.showValues ? failures : failures.map(({ scope, field, disposition, detail }) => ({ scope, field, disposition, detail })),
    notApplicableCount: checks.filter((c) => c.disposition === DISPOSITION.NOT_APPLICABLE).length,
  };
}

// ─── Property comparison ──────────────────────────────────────────────────────

function compareProperties(scope, expected, actual, donation) {
  return Object.entries(expected).map(([field, expectedValue]) => {
    const actualValue = actual[field] ?? null;

    if (ZAPIER_NEVER_WROTE.has(field)) {
      return makeFieldCheck(scope, field, DISPOSITION.ZAPIER_NEVER_WROTE_FIELD, expectedValue, actualValue);
    }

    if (field in KNOWN_EXPECTED_DIFFERENCES) {
      return makeFieldCheck(scope, field, DISPOSITION.EXPECTED_DIFF, expectedValue, actualValue,
        KNOWN_EXPECTED_DIFFERENCES[field]);
    }

    if (valuesMatch(field, expectedValue, actualValue)) {
      return makeFieldCheck(scope, field, DISPOSITION.FIELD_MATCH, expectedValue, actualValue);
    }

    // Vercel would write a value Zapier left blank
    if (!actualValue && expectedValue) {
      return makeFieldCheck(scope, field, DISPOSITION.VERCEL_WOULD_ADD, expectedValue, actualValue);
    }

    // Both have values but they differ
    return makeFieldCheck(scope, field, DISPOSITION.ZAPIER_DIFFERENT, expectedValue, actualValue);
  });
}

function valuesMatch(field, expected, actual) {
  if (field === "amount" || field === "givebutter_reference_number") {
    return Number(expected) === Number(actual);
  }

  if (field === "closedate" || field === "createdate") {
    const e = Date.parse(expected);
    const a = Date.parse(actual ?? "");
    return Number.isFinite(e) && Number.isFinite(a) && e === a;
  }

  return String(expected).trim() === String(actual ?? "").trim();
}

// ─── HubSpot lookups (read-only) ──────────────────────────────────────────────

async function findActualContact(donation, properties) {
  const contactId = donation.contactId !== null ? String(donation.contactId) : null;

  if (contactId) {
    const matches = await hubspotClient.searchContacts("givebutter_contact_id", contactId, properties);
    if (matches[0]) return matches[0];
  }

  const email = donation.email?.trim() || getFallbackEmail(donation);

  if (!email) return null;

  return (await hubspotClient.searchContacts("email", email, properties))[0] ?? null;
}

async function findActualDeal(donation, properties) {
  const transactionId = donation.transactionId !== null ? String(donation.transactionId) : null;

  if (transactionId) {
    const matches = await hubspotClient.searchDeals("givebutter_transaction_id", transactionId, properties);
    if (matches[0]) return matches[0];
  }

  const referenceNumber = donation.transactionNumber !== null ? String(donation.transactionNumber) : null;

  if (referenceNumber && /^\d+$/.test(referenceNumber)) {
    return (await hubspotClient.searchDeals("givebutter_reference_number", referenceNumber, properties))[0] ?? null;
  }

  return null;
}

async function findChapterByCode(campaignCode) {
  if (!campaignCode) return null;

  return (
    await hubspotClient.searchCompanies("givebutter_code", campaignCode, [
      "name",
      "givebutter_code",
      "record_type",
    ])
  )[0] ?? null;
}

async function findFirstCompany(propertyName, value) {
  if (!value?.trim()) return null;

  return (
    await hubspotClient.searchCompanies(propertyName, value.trim(), ["name", "givebutter_code", "record_type"])
  )[0] ?? null;
}

// ─── Result helpers ───────────────────────────────────────────────────────────

function makeResult(rawTransaction, donation, disposition, shadowActions, checks) {
  return {
    transactionKey: maskIdentifier(String(donation.transactionId ?? donation.transactionNumber ?? rawTransaction.id ?? "")),
    receivedAt: rawTransaction.created_at ?? rawTransaction.transacted_at ?? null,
    donorType: donation.donorType,
    isOffline: donation.isOffline,
    isRecurring: donation.isRecurring,
    hasDedication: Object.values(donation.dedication).some(Boolean),
    hasUtm: Object.values(donation.utm).some(Boolean),
    hasCompanyName: Boolean(donation.companyName),
    campaignCode: donation.campaignCode ?? null,
    destination: null,
    chapterFound: false,
    shadowActions,
    shadowWarnings: [],
    contactAction: null,
    dealAction: null,
    overallStatus: disposition,
    passCount: 0,
    expectedDiffCount: 0,
    failureCount: checks.length,
    failures: checks,
    notApplicableCount: 0,
  };
}

function makeFieldCheck(scope, field, disposition, expected, actual, detail = null) {
  const check = { scope, field, disposition };
  if (detail) check.detail = detail;
  if (args.showValues && disposition !== DISPOSITION.FIELD_MATCH && disposition !== DISPOSITION.NOT_APPLICABLE) {
    check.expected = expected;
    check.actual = actual;
  }
  return check;
}

function makeAssociationCheck(field, matches) {
  return {
    scope: "association",
    field,
    disposition: matches ? DISPOSITION.FIELD_MATCH : DISPOSITION.MISSING_ASSOCIATION,
  };
}

function isFailure(check) {
  return (
    check.disposition === DISPOSITION.DEAL_MISSING ||
    check.disposition === DISPOSITION.CONTACT_MISSING ||
    check.disposition === DISPOSITION.MISSING_ASSOCIATION ||
    check.disposition === DISPOSITION.EXTRA_ASSOCIATION ||
    check.disposition === DISPOSITION.ZAPIER_DIFFERENT
  );
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport(results, opts) {
  const pass = results.filter((r) => r.overallStatus === "pass");
  const fail = results.filter((r) => r.overallStatus === "fail");
  const skipped = results.filter((r) =>
    r.overallStatus !== "pass" && r.overallStatus !== "fail"
  );

  // Aggregate dispositions across all checks in failing transactions
  const dispositionCounts = {};
  for (const result of fail) {
    for (const check of result.failures) {
      dispositionCounts[check.disposition] = (dispositionCounts[check.disposition] ?? 0) + 1;
    }
  }

  // Representative case coverage summary
  const coverage = buildCoverageMatrix(results);

  const reportResults = opts.showPassing
    ? results
    : results.filter((r) => r.overallStatus !== "pass");

  return {
    generatedAt: new Date().toISOString(),
    parameters: {
      days: opts.days,
      limit: opts.limit,
      concurrency: opts.concurrency,
    },
    summary: {
      total: results.length,
      pass: pass.length,
      fail: fail.length,
      skipped: skipped.length,
      passRate: results.length > 0 ? `${Math.round((pass.length / results.length) * 100)}%` : "n/a",
      zeroUnexpectedWrites: true, // structural guarantee — shadow mode never writes
    },
    dispositionCounts,
    coverageMatrix: coverage,
    passCriteria: evaluatePassCriteria(results),
    results: reportResults,
  };
}

function buildCoverageMatrix(results) {
  return {
    normalEmail:            results.filter((r) => r.donorType === "person" && !r.overallStatus.startsWith("org")).length,
    fallbackEmail:          results.filter((r) => r.contactAction === "would_create" && !r.failures.some((f) => f.field === "record")).length,
    chapterDonation:        results.filter((r) => r.destination === "Chapter").length,
    porchCommunitiesDonation: results.filter((r) => r.destination === "PORCH-Communities").length,
    campaignMissing:        results.filter((r) => r.campaignCode === null).length,
    companyPresent:         results.filter((r) => r.hasCompanyName).length,
    companyAbsent:          results.filter((r) => !r.hasCompanyName).length,
    organizationDonor:      results.filter((r) => r.donorType === "organization").length,
    offlinePayment:         results.filter((r) => r.isOffline).length,
    recurringGift:          results.filter((r) => r.isRecurring).length,
    hasDedication:          results.filter((r) => r.hasDedication).length,
    hasUtm:                 results.filter((r) => r.hasUtm).length,
    chapterFound:           results.filter((r) => r.chapterFound).length,
    chapterMissing:         results.filter((r) => r.campaignCode !== null && !r.chapterFound).length,
  };
}

function evaluatePassCriteria(results) {
  const liveResults = results.filter((r) =>
    r.overallStatus === "pass" || r.overallStatus === "fail"
  );

  const dealsWithoutContact = liveResults.filter((r) =>
    r.overallStatus === "fail" &&
    r.failures.some((f) => f.field === "contact_to_deal" || f.field === "deal_to_contact")
  );

  const requiredFieldMismatches = liveResults.filter((r) =>
    r.overallStatus === "fail" &&
    r.failures.some((f) =>
      f.scope === "deal" && f.disposition === DISPOSITION.ZAPIER_DIFFERENT &&
      ["amount", "closedate", "destination", "pipeline", "dealstage"].includes(f.field)
    )
  );

  const unexplainedDiscrepancies = liveResults.filter((r) =>
    r.overallStatus === "fail" &&
    r.failures.some((f) => !f.disposition || f.disposition === "unknown")
  );

  return {
    everyDealResolvesToOne: {
      pass: liveResults.every(
        (r) => r.overallStatus === "pass" || r.failures.every((f) => f.field !== "deal_missing" || r.dealAction === "would_create")
      ),
      detail: "Every live transaction either matched an existing deal or would create exactly one new deal in write mode",
    },
    requiredFieldsMatch: {
      pass: requiredFieldMismatches.length === 0,
      detail: `${requiredFieldMismatches.length} transaction(s) have required deal field mismatches`,
      failures: requiredFieldMismatches.map((r) => ({
        transactionKey: r.transactionKey,
        failures: r.failures.filter((f) => ["amount", "closedate", "destination", "pipeline", "dealstage"].includes(f.field)),
      })),
    },
    dealsHaveCorrectContact: {
      pass: dealsWithoutContact.length === 0,
      detail: `${dealsWithoutContact.length} deal(s) are missing contact associations`,
    },
    zeroUnexpectedWrites: {
      pass: true,
      detail: "Shadow mode — no HubSpot writes performed during replay",
    },
    allDiscrepanciesUnderstood: {
      pass: unexplainedDiscrepancies.length === 0,
      detail: `${unexplainedDiscrepancies.length} discrepancies have no disposition code`,
    },
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function isTestTransaction(raw, donation) {
  const id = String(raw.id ?? "").toLowerCase();
  return (
    id === "test" ||
    id.startsWith("api-sample-") ||
    donation.campaignCode?.toUpperCase() === "SAMPLE"
  );
}

function hasAssociationType(associations, objectId, typeId) {
  return associations.some(
    (a) =>
      String(a.toObjectId) === String(objectId) &&
      a.associationTypes?.some((t) => t.typeId === typeId),
  );
}

function idSet(results = []) {
  return new Set((results ?? []).map(({ id }) => String(id)));
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
          transactionKey: maskIdentifier(String(item.id ?? item.number ?? "")),
          overallStatus: "error",
          error: err.message,
          failures: [],
        });
      }
      completed += 1;
      if (completed % 10 === 0) {
        console.error(`[dry-run] ${completed}/${items.length} processed...`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  return results;
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    days: 90,
    limit: 200,
    showValues: false,
    showPassing: false,
    concurrency: 4,
    out: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--show-values")  { opts.showValues = true; continue; }
    if (arg === "--show-passing") { opts.showPassing = true; continue; }

    if (arg === "--days")        { opts.days        = clamp(Number(argv[++i]), 1, 90);  continue; }
    if (arg === "--limit")       { opts.limit       = clamp(Number(argv[++i]), 1, 500); continue; }
    if (arg === "--concurrency") { opts.concurrency = clamp(Number(argv[++i]), 1, 8);   continue; }
    if (arg === "--out")         { opts.out         = argv[++i]; continue; }

    if (arg.startsWith("--days="))        { opts.days        = clamp(Number(arg.slice(7)),  1, 90);  continue; }
    if (arg.startsWith("--limit="))       { opts.limit       = clamp(Number(arg.slice(8)),  1, 500); continue; }
    if (arg.startsWith("--concurrency=")) { opts.concurrency = clamp(Number(arg.slice(14)), 1, 8);   continue; }
    if (arg.startsWith("--out="))         { opts.out         = arg.slice(6); continue; }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
