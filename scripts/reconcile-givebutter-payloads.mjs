import { get, list } from "@vercel/blob";

import {
  mapGivebutterDonation,
} from "../src/lib/givebutter/payloads.ts";
import { createHubSpotClient } from "../src/lib/hubspot/client.ts";
import {
  buildContactProperties,
  buildDealProperties,
  CHAPTER_FINANCIAL_DONOR_ASSOCIATION_TYPE_ID,
  CHAPTER_DONATION_CONTACT_ASSOCIATION_TYPE_ID,
  COMPANY_DONATION_CONTACT_ASSOCIATION_TYPE_ID,
} from "../src/lib/hubspot/donation-parity.ts";

const BLOB_PREFIX = "givebutter-payload-logs/";
const DEAL_CONTACT_DEFAULT_TYPE_ID = 3;
const DEAL_CHAPTER_FINANCIAL_DONOR_TYPE_ID = CHAPTER_FINANCIAL_DONOR_ASSOCIATION_TYPE_ID;
const DEAL_CHAPTER_DONATION_CONTACT_TYPE_ID = CHAPTER_DONATION_CONTACT_ASSOCIATION_TYPE_ID;
const COMPANY_DONATION_CONTACT_TYPE_ID = COMPANY_DONATION_CONTACT_ASSOCIATION_TYPE_ID;

const args = parseArgs(process.argv.slice(2));
const client = createHubSpotClient();
const blobResult = await list({ prefix: BLOB_PREFIX, limit: 1000 });
const blobs = blobResult.blobs
  .sort((left, right) => right.uploadedAt.getTime() - left.uploadedAt.getTime())
  .slice(0, args.limit);

if (blobs.length === 0) {
  console.log(JSON.stringify({ count: 0, results: [] }, null, 2));
  process.exit(0);
}

const results = await Promise.all(blobs.map(reconcileBlob));

const summary = {
  count: results.length,
  matches: results.filter((result) => result.status === "match").length,
  mismatches: results.filter((result) => result.status === "mismatch").length,
  missing: results.filter((result) => result.status === "missing").length,
  ignoredTests: results.filter((result) => result.status === "ignored_test").length,
};

console.log(JSON.stringify({ summary, results }, null, 2));

async function reconcileBlob(blob) {
  const stored = await readStoredPayload(blob.pathname);
  const donation = mapGivebutterDonation(stored.payload);

  if (isTestPayload(stored.payload, donation)) {
    return {
      blob: blob.pathname,
      receivedAt: stored.receivedAt,
      transactionKey: maskIdentifier(donation.transactionNumber ?? donation.transactionId),
      route: null,
      status: "ignored_test",
      failedChecks: [],
      passedChecks: 0,
      expectedDifferences: 0,
      notApplicableChecks: 1,
    };
  }

  const expectedContact = buildContactProperties(donation);
  const contact = await findContact(donation, Object.keys(expectedContact));
  const chapter = await findFirstCompany("givebutter_code", donation.campaignCode);
  const destination = chapter ? "Chapter" : "PORCH-Communities";
  const expectedDeal = buildDealProperties(donation, destination);
  const deal = await findDeal(donation, Object.keys(expectedDeal));
  const checks = [];

  if (!contact) {
    checks.push(failure("contact", "missing_contact"));
  } else {
    checks.push(...compareProperties("contact", expectedContact, contact.properties));
  }

  if (!deal) {
    checks.push(failure("deal", "missing_deal"));
  } else {
    checks.push(...compareProperties("deal", expectedDeal, deal.properties));
  }

  if (contact && deal) {
    const [loadedContact, loadedDeal, dealContacts] = await Promise.all([
      client.getContact(contact.id),
      client.getDeal(deal.id),
      client.getDealContactAssociations(deal.id),
    ]);
    const contactDealIds = ids(loadedContact.associations?.deals?.results);
    const dealContactIds = ids(loadedDeal.associations?.contacts?.results);
    const dealCompanyIds = ids(loadedDeal.associations?.companies?.results);

    checks.push(
      associationCheck("contact_to_deal", contactDealIds.has(deal.id)),
      associationCheck("deal_to_contact", dealContactIds.has(contact.id)),
      associationCheck(
        "default_deal_contact_label",
        hasAssociationType(dealContacts, contact.id, DEAL_CONTACT_DEFAULT_TYPE_ID),
      ),
    );

    if (chapter) {
      checks.push(
        associationCheck("deal_to_chapter", dealCompanyIds.has(chapter.id)),
        associationCheck(
          "chapter_financial_donor",
          hasAssociationType(dealContacts, contact.id, DEAL_CHAPTER_FINANCIAL_DONOR_TYPE_ID),
        ),
      );

      const companyContacts = await client.getCompanyContactAssociations(chapter.id);
      const chapterLead = companyContacts.find((association) =>
        association.associationTypes?.some(
          (type) => type.typeId === COMPANY_DONATION_CONTACT_TYPE_ID,
        ),
      );

      if (chapterLead) {
        checks.push(
          associationCheck(
            "chapter_donation_contact",
            hasAssociationType(
              dealContacts,
              String(chapterLead.toObjectId),
              DEAL_CHAPTER_DONATION_CONTACT_TYPE_ID,
            ),
          ),
        );
      } else {
        checks.push({ scope: "association", field: "chapter_donation_contact", status: "not_applicable" });
      }
    }

    if (donation.companyName) {
      const donorCompany = await findFirstCompany("name", donation.companyName);

      if (!donorCompany) {
        checks.push(failure("company", "missing_donor_company"));
      } else {
        const contactCompanyIds = ids(loadedContact.associations?.companies?.results);
        checks.push(
          associationCheck("contact_to_donor_company", contactCompanyIds.has(donorCompany.id)),
          associationCheck("deal_to_donor_company", dealCompanyIds.has(donorCompany.id)),
        );
      }
    }
  }

  const failed = checks.filter((check) => check.status === "mismatch");
  const missing = failed.some((check) => check.field.startsWith("missing_"));

  return {
    blob: blob.pathname,
    receivedAt: stored.receivedAt,
    transactionKey: maskIdentifier(donation.transactionNumber ?? donation.transactionId),
    route: destination,
    status: failed.length === 0 ? "match" : missing ? "missing" : "mismatch",
    failedChecks: failed.map((check) =>
      args.showValues ? check : { scope: check.scope, field: check.field, status: check.status },
    ),
    passedChecks: checks.filter((check) => check.status === "match").length,
    expectedDifferences: checks.filter((check) => check.status === "expected_difference").length,
    notApplicableChecks: checks.filter((check) => check.status === "not_applicable").length,
  };
}

async function readStoredPayload(pathname) {
  const result = await get(pathname, { access: "private", useCache: false });

  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error(`Unable to read Blob payload: ${pathname}`);
  }

  return JSON.parse(await new Response(result.stream).text());
}

async function findContact(donation, properties) {
  if (donation.contactId !== null) {
    const matches = await client.searchContacts(
      "givebutter_contact_id",
      String(donation.contactId),
      properties,
    );

    if (matches[0]) {
      return matches[0];
    }
  }

  const email = donation.email?.trim() || null;

  if (!email) {
    return null;
  }

  return (await client.searchContacts("email", email, properties))[0] ?? null;
}

async function findDeal(donation, properties) {
  if (donation.transactionId !== null) {
    const matches = await client.searchDeals(
      "givebutter_transaction_id",
      String(donation.transactionId),
      properties,
    );

    if (matches[0]) {
      return matches[0];
    }
  }

  if (donation.transactionNumber === null) {
    return null;
  }

  return (
    await client.searchDeals(
      "givebutter_reference_number",
      String(donation.transactionNumber),
      properties,
    )
  )[0] ?? null;
}

async function findFirstCompany(propertyName, value) {
  if (!value) {
    return null;
  }

  return (
    await client.searchCompanies(propertyName, value, ["name", "givebutter_code", "record_type"])
  )[0] ?? null;
}

function compareProperties(scope, expected, actual) {
  return Object.entries(expected).map(([field, expectedValue]) => {
    const actualValue = actual[field] ?? null;
    const matches = equivalent(field, expectedValue, actualValue);

    if (field === "givebutter_transaction_id" && !actualValue && !expectedValue) {
      return { scope, field, status: "expected_difference" };
    }

    return matches
      ? { scope, field, status: "match" }
      : {
          scope,
          field,
          status: "mismatch",
          expected: expectedValue,
          actual: actualValue,
        };
  });
}

function isTestPayload(payload, donation) {
  const eventId = String(payload.id ?? "").toLowerCase();

  return (
    eventId === "test" ||
    eventId.startsWith("api-sample-") ||
    donation.campaignCode?.toUpperCase() === "SAMPLE"
  );
}

function equivalent(field, expected, actual) {
  if (field === "amount" || field === "givebutter_reference_number") {
    return Number(expected) === Number(actual);
  }

  if (field === "closedate" || field === "createdate") {
    return Date.parse(expected) === Date.parse(actual);
  }

  return String(expected).trim() === String(actual ?? "").trim();
}

function hasAssociationType(associations, objectId, typeId) {
  return associations.some(
    (association) =>
      String(association.toObjectId) === String(objectId) &&
      association.associationTypes?.some((type) => type.typeId === typeId),
  );
}

function ids(results = []) {
  return new Set(results.map(({ id }) => String(id)));
}

function associationCheck(field, matches) {
  return matches
    ? { scope: "association", field, status: "match" }
    : { scope: "association", field, status: "mismatch", expected: true, actual: false };
}

function failure(scope, field) {
  return { scope, field, status: "mismatch", expected: true, actual: false };
}

function maskIdentifier(value) {
  const normalized = String(value ?? "");

  if (normalized.length <= 4) {
    return "****";
  }

  return `***${normalized.slice(-4)}`;
}

function parseArgs(argv) {
  const parsed = { limit: 3, showValues: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--show-values") {
      parsed.showValues = true;
      continue;
    }

    if (arg === "--limit") {
      parsed.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      parsed.limit = Number(arg.slice("--limit=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > 100) {
    throw new Error("--limit must be an integer between 1 and 100.");
  }

  return parsed;
}
