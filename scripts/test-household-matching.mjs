/**
 * Dry-run household matching test against live HubSpot data.
 *
 * Fetches all HubSpot contacts with a last name and all Household companies,
 * runs each eligible contact through the household matching engine, and
 * prints a summary report. No HubSpot writes are performed.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env scripts/test-household-matching.mjs [options]
 *
 * Options:
 *   --limit <n>       Cap on total contacts to process (default: 200)
 *   --out <file>      Write JSON report to a file instead of stdout
 *   --verbose         Print per-contact match details
 */

import { writeFileSync } from "node:fs";

import { createHubSpotClient } from "../src/lib/hubspot/client.ts";
import {
  findBestHouseholdMatch,
  normalizeLastName,
  normalizeStreet,
  normalizeZip,
} from "../src/lib/householding/matching.ts";

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const outArg = args.indexOf("--out");
const verbose = args.includes("--verbose");

const CONTACT_LIMIT = limitArg !== -1 ? Number(args[limitArg + 1]) : 200;
const OUT_FILE = outArg !== -1 ? args[outArg + 1] : null;

const CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "address",
  "city",
  "state",
  "zip",
  "givebutter_contact_id",
  "household_match_status",
  "hs_object_id",
];

const COMPANY_PROPERTIES = [
  "name",
  "record_type",
  "email",
  "address",
  "city",
  "state",
  "zip",
];

async function fetchAllContacts(client) {
  const contacts = [];
  let after = undefined;

  while (contacts.length < CONTACT_LIMIT) {
    const remaining = CONTACT_LIMIT - contacts.length;
    const pageSize = Math.min(remaining, 100);

    const response = await hubspotSearch(client, "contacts", {
      filterGroups: [
        {
          filters: [{ propertyName: "lastname", operator: "HAS_PROPERTY" }],
        },
      ],
      properties: CONTACT_PROPERTIES,
      limit: pageSize,
      after,
    });

    contacts.push(...(response.results ?? []));

    if (!response.paging?.next?.after || contacts.length >= CONTACT_LIMIT) {
      break;
    }

    after = response.paging.next.after;
  }

  return contacts;
}

async function fetchAllHouseholdCompanies(client) {
  const companies = [];
  let after = undefined;

  while (true) {
    const response = await hubspotSearch(client, "companies", {
      filterGroups: [
        {
          filters: [{ propertyName: "record_type", operator: "EQ", value: "Household" }],
        },
      ],
      properties: COMPANY_PROPERTIES,
      limit: 100,
      after,
    });

    companies.push(...(response.results ?? []));

    if (!response.paging?.next?.after) {
      break;
    }

    after = response.paging.next.after;
  }

  return companies;
}

async function hubspotSearch(client, objectType, body) {
  const accessToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/${objectType}/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HubSpot search failed (${response.status}): ${text}`);
  }

  return response.json();
}

function toMatchableContact(contact) {
  const p = contact.properties;
  return {
    firstName: p.firstname ?? null,
    lastName: p.lastname ?? null,
    email: p.email ?? null,
    street: p.address ?? null,
    zip: p.zip ?? null,
  };
}

function toHouseholdCandidate(company) {
  const p = company.properties;
  return {
    hubspotCompanyId: company.id,
    householdName: p.name ?? "",
    firstName: null,
    lastName: extractLastNameFromHouseholdName(p.name),
    email: p.email ?? null,
    street: p.address ?? null,
    zip: p.zip ?? null,
  };
}

function extractLastNameFromHouseholdName(name) {
  if (!name) return null;
  // "Smith Household" → "Smith"
  return name.replace(/\s+household$/i, "").trim() || null;
}

function isEligibleForMatching(contact) {
  const p = contact.properties;

  if (!p.lastname) return false;

  // Skip already-processed contacts (confirmed or no-match)
  const status = p.household_match_status;
  if (status === "confirmed" || status === "no_match" || status === "auto_householded") {
    return false;
  }

  return true;
}

async function main() {
  const client = createHubSpotClient();

  process.stderr.write("Fetching household companies...\n");
  const companies = await fetchAllHouseholdCompanies(client);
  process.stderr.write(`Found ${companies.length} Household companies.\n`);

  const candidates = companies.map(toHouseholdCandidate);

  process.stderr.write(`Fetching up to ${CONTACT_LIMIT} contacts with last names...\n`);
  const allContacts = await fetchAllContacts(client);
  process.stderr.write(`Fetched ${allContacts.length} contacts.\n`);

  const eligible = allContacts.filter(isEligibleForMatching);
  const skipped = allContacts.length - eligible.length;
  process.stderr.write(
    `${eligible.length} eligible for matching, ${skipped} skipped (already processed).\n`,
  );

  if (candidates.length === 0) {
    process.stderr.write(
      "No Household companies found. Nothing to match against.\n" +
      "Create at least one Company with record_type = Household to use this script.\n",
    );
    process.exit(0);
  }

  const results = {
    summary: {
      contactsFetched: allContacts.length,
      contactsEligible: eligible.length,
      contactsSkipped: skipped,
      householdCandidates: candidates.length,
      auto_household: 0,
      needs_review: 0,
      no_match: 0,
    },
    autoHousehold: [],
    needsReview: [],
    noMatch: [],
  };

  for (const contact of eligible) {
    const matchable = toMatchableContact(contact);
    const result = findBestHouseholdMatch(matchable, candidates);
    const p = contact.properties;

    const entry = {
      contactId: contact.id,
      name: [p.firstname, p.lastname].filter(Boolean).join(" "),
      email: p.email ?? null,
      street: p.address ?? null,
      zip: p.zip ?? null,
      normalizedStreet: normalizeStreet(p.address),
      normalizedZip: normalizeZip(p.zip),
      score: result.score,
      signals: result.signals,
      decision: result.decision,
      matchedHousehold: result.candidate
        ? {
            id: result.candidate.hubspotCompanyId,
            name: result.candidate.householdName,
            street: result.candidate.street ?? null,
            zip: result.candidate.zip ?? null,
          }
        : null,
    };

    results.summary[result.decision] += 1;

    if (result.decision === "auto_household") {
      results.autoHousehold.push(entry);
    } else if (result.decision === "needs_review") {
      results.needsReview.push(entry);
    } else {
      results.noMatch.push(entry);
    }
  }

  // Sort each bucket by score descending
  results.autoHousehold.sort((a, b) => b.score - a.score);
  results.needsReview.sort((a, b) => b.score - a.score);

  if (OUT_FILE) {
    writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
    process.stderr.write(`Report written to ${OUT_FILE}\n`);
  } else {
    printReport(results, verbose);
  }
}

function printReport(results, verbose) {
  const { summary, autoHousehold, needsReview } = results;

  console.log("\n=== HOUSEHOLD MATCH DRY RUN ===\n");
  console.log(`Contacts fetched:    ${summary.contactsFetched}`);
  console.log(`Contacts eligible:   ${summary.contactsEligible}`);
  console.log(`Contacts skipped:    ${summary.contactsSkipped} (already processed)`);
  console.log(`Household companies: ${summary.householdCandidates}`);
  console.log("");
  console.log(`Auto-household:  ${summary.auto_household}`);
  console.log(`Needs review:    ${summary.needs_review}`);
  console.log(`No match:        ${summary.no_match}`);

  if (autoHousehold.length > 0) {
    console.log("\n--- AUTO-HOUSEHOLD (score ≥ 80) ---");
    for (const e of autoHousehold) {
      console.log(`  [${e.score}] ${e.name} → ${e.matchedHousehold?.name} (${e.signals.join(", ")})`);
      if (verbose) {
        console.log(`        contact street: "${e.normalizedStreet}"  zip: "${e.normalizedZip}"`);
        console.log(`        household: ${e.matchedHousehold?.id}`);
      }
    }
  }

  if (needsReview.length > 0) {
    console.log("\n--- NEEDS REVIEW (score 40–79) ---");
    for (const e of needsReview) {
      const match = e.matchedHousehold ? `→ ${e.matchedHousehold.name}` : "(no candidate)";
      console.log(`  [${e.score}] ${e.name} ${match} (${e.signals.join(", ")})`);
      if (verbose) {
        console.log(`        contact street: "${e.normalizedStreet}"  zip: "${e.normalizedZip}"`);
      }
    }
  }

  if (verbose && results.noMatch.length > 0) {
    console.log("\n--- NO MATCH (score < 40, sample of 20) ---");
    for (const e of results.noMatch.slice(0, 20)) {
      console.log(`  [${e.score}] ${e.name} — ${e.signals.join(", ")}`);
    }
  }

  console.log("");
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
