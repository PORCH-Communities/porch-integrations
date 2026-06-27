import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContactProperties,
  buildDealProperties,
  getDonationParityMode,
  processGivebutterDonation,
} from "./donation-parity.ts";

test("defaults to shadow mode unless write is explicitly configured", () => {
  assert.equal(getDonationParityMode(undefined), "shadow");
  assert.equal(getDonationParityMode("dry_run"), "shadow");
  assert.equal(getDonationParityMode("WRITE"), "write");
});

test("builds the audited contact and deal field mappings", () => {
  const donation = makeDonation({ email: null });

  assert.deepEqual(buildContactProperties(donation), {
    address: "123 Main Street",
    city: "Chapel Hill",
    state: "NC",
    zip: "27516",
    country: "US",
    firstname: "Jamie",
    lastname: "Donor",
    company: "Example Employer",
    givebutter_contact_id: "contact-123",
    mobilephone: "9195550123",
    phone: "9195550123",
    hs_latest_source: "DIRECT_TRAFFIC",
    hubspot_owner_id: "807444275",
  });

  assert.deepEqual(buildDealProperties(donation, "Chapter"), {
    dealname: "$125 Jamie Donor",
    pipeline: "155504019",
    dealstage: "261678424",
    amount: "125",
    chapter_city: "Chapel Hill",
    chapter_state: "NC",
    closedate: "2026-06-27T12:00:00.000Z",
    createdate: "2026-06-27T12:00:00.000Z",
    dedication_name: "A Friend",
    dedication_recipient_email: "recipient@example.org",
    dedication_recipient_name: "Recipient Name",
    dedication_type: "In honor of",
    description: "3240015459",
    donor_address: "123 Main Street, Chapel Hill, NC 27516",
    givebutter_campaign: "PORCH Chapel Hill-ABC123",
    givebutter_company_name: "Example Employer",
    givebutter_message: "Thank you",
    givebutter_reference_number: "3240015459",
    givebutter_transaction_id: "txn-token",
    hubspot_owner_id: "807444275",
    destination: "Chapter",
    referrer: "https://example.org",
    utm_campaign: "summer",
    utm_content: "button",
    utm_medium: "email",
    utm_source: "newsletter",
    utm_term: "donate",
  });
});

test("processes an offline gift without synthetic email or mailing address", async () => {
  const calls = [];
  const client = makeClient(calls);
  const donation = makeDonation({
    email: null,
    isOffline: true,
    paymentMethod: "check",
    address: {
      company: null,
      line1: null,
      line2: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    },
    companyName: null,
  });

  const result = await processGivebutterDonation(client, donation, "write");
  const createContactCall = calls.find(([name]) => name === "createContact");

  assert.equal(result.status, "processed");
  assert.ok(createContactCall);
  assert.equal("email" in createContactCall[1], false);
  assert.equal("address" in createContactCall[1], false);
  assert.equal(createContactCall[1].givebutter_contact_id, "contact-123");
});

test("shadow mode performs lookups and reports the full chapter path without writes", async () => {
  const calls = [];
  const client = makeClient(calls, {
    async searchContacts(propertyName) {
      calls.push(["searchContacts", propertyName]);
      return [{ id: "contact-existing", properties: {} }];
    },
    async searchDeals(propertyName) {
      calls.push(["searchDeals", propertyName]);
      return [{ id: "deal-existing", properties: {} }];
    },
    async searchCompanies(propertyName) {
      calls.push(["searchCompanies", propertyName]);

      if (propertyName === "givebutter_code") {
        return [{ id: "chapter-1", properties: { name: "PORCH Chapel Hill" } }];
      }

      return [{ id: "employer-1", properties: { name: "Example Employer" } }];
    },
    async getCompanyContactAssociations() {
      calls.push(["getCompanyContactAssociations"]);
      return [
        {
          toObjectId: "chapter-lead-1",
          associationTypes: [{ category: "USER_DEFINED", typeId: 3 }],
        },
      ];
    },
  });

  const result = await processGivebutterDonation(client, makeDonation(), "shadow");

  assert.equal(result.status, "shadowed");
  assert.equal(result.destination, "Chapter");
  assert.equal(result.chapterCompanyId, "chapter-1");
  assert.deepEqual(result.contact, { action: "would_update", id: "contact-existing" });
  assert.deepEqual(result.deal, { action: "would_update", id: "deal-existing" });
  assert.deepEqual(result.donorCompany, { action: "would_update", id: "employer-1" });
  assert.ok(result.actions.includes("would_add_chapter_donation_contact_association"));
  assert.equal(calls.some(([name]) => name.startsWith("create")), false);
  assert.equal(calls.some(([name]) => name.startsWith("update")), false);
  assert.equal(calls.some(([name]) => name.startsWith("associate")), false);
});

test("write mode creates the PORCH Communities path and donor-company associations", async () => {
  const calls = [];
  const client = makeClient(calls);
  const result = await processGivebutterDonation(
    client,
    makeDonation({ campaignCode: null, campaignTitle: null }),
    "write",
  );

  assert.equal(result.status, "processed");
  assert.equal(result.destination, "PORCH-Communities");
  assert.deepEqual(result.contact, { action: "create", id: "contact-created" });
  assert.deepEqual(result.deal, { action: "create", id: "deal-created" });
  assert.deepEqual(result.donorCompany, { action: "create", id: "company-created" });
  assert.ok(calls.some(([name]) => name === "createContact"));
  assert.ok(calls.some(([name]) => name === "createDeal"));
  assert.ok(calls.some(([name]) => name === "associateContactToDeal"));
  assert.ok(calls.some(([name]) => name === "associateContactToCompany"));
  assert.ok(calls.some(([name]) => name === "associateDealToCompany"));
  assert.equal(calls.some(([name]) => name === "associateContactToDealWithType"), false);
});

test("a retried chapter donation updates existing records and reapplies idempotent associations", async () => {
  const calls = [];
  const client = makeClient(calls, {
    async searchContacts() {
      return [{ id: "contact-existing", properties: {} }];
    },
    async searchDeals() {
      return [{ id: "deal-existing", properties: {} }];
    },
    async searchCompanies(propertyName) {
      if (propertyName === "givebutter_code") {
        return [{ id: "chapter-1", properties: { givebutter_code: "ABC123" } }];
      }

      return [{ id: "employer-existing", properties: { name: "Example Employer" } }];
    },
    async getCompanyContactAssociations() {
      return [
        {
          toObjectId: "chapter-lead-1",
          associationTypes: [{ category: "USER_DEFINED", typeId: 3 }],
        },
      ];
    },
  });

  const result = await processGivebutterDonation(client, makeDonation(), "write");

  assert.deepEqual(result.contact, { action: "update", id: "contact-existing" });
  assert.deepEqual(result.deal, { action: "update", id: "deal-existing" });
  assert.equal(calls.some(([name]) => name === "createContact"), false);
  assert.equal(calls.some(([name]) => name === "createDeal"), false);
  assert.ok(
    calls.some(
      ([name, contactId, dealId, typeId]) =>
        name === "associateContactToDealWithType" &&
        contactId === "contact-existing" &&
        dealId === "deal-existing" &&
        typeId === 10,
    ),
  );
  assert.ok(
    calls.some(
      ([name, contactId, dealId, typeId]) =>
        name === "associateContactToDealWithType" &&
        contactId === "chapter-lead-1" &&
        dealId === "deal-existing" &&
        typeId === 13,
    ),
  );
});

test("returns needs_attention before any CRM call when identity is unusable", async () => {
  const calls = [];
  const result = await processGivebutterDonation(
    makeClient(calls),
    makeDonation({ email: null, contactId: null }),
    "write",
  );

  assert.equal(result.status, "needs_attention");
  assert.match(result.reason, /neither an email nor a Givebutter Contact ID/);
  assert.deepEqual(calls, []);
});

function makeClient(calls, overrides = {}) {
  return {
    async searchContacts(propertyName, value) {
      calls.push(["searchContacts", propertyName, value]);
      return [];
    },
    async searchCompanies(propertyName, value) {
      calls.push(["searchCompanies", propertyName, value]);
      return [];
    },
    async searchDeals(propertyName, value) {
      calls.push(["searchDeals", propertyName, value]);
      return [];
    },
    async createContact(properties) {
      calls.push(["createContact", properties]);
      return { id: "contact-created", properties };
    },
    async createCompany(properties) {
      calls.push(["createCompany", properties]);
      return { id: "company-created", properties };
    },
    async createDeal(properties) {
      calls.push(["createDeal", properties]);
      return { id: "deal-created", properties };
    },
    async updateContact(id, properties) {
      calls.push(["updateContact", id, properties]);
      return { id, properties };
    },
    async updateDeal(id, properties) {
      calls.push(["updateDeal", id, properties]);
      return { id, properties };
    },
    async associateContactToDeal(contactId, dealId) {
      calls.push(["associateContactToDeal", contactId, dealId]);
    },
    async associateContactToDealWithType(contactId, dealId, typeId) {
      calls.push(["associateContactToDealWithType", contactId, dealId, typeId]);
    },
    async associateContactToCompany(contactId, companyId) {
      calls.push(["associateContactToCompany", contactId, companyId]);
    },
    async associateDealToCompany(dealId, companyId) {
      calls.push(["associateDealToCompany", dealId, companyId]);
    },
    async getCompanyContactAssociations(companyId) {
      calls.push(["getCompanyContactAssociations", companyId]);
      return [];
    },
    ...overrides,
  };
}

function makeDonation(overrides = {}) {
  return {
    eventId: "event-1",
    transactionId: "txn-token",
    transactionNumber: "3240015459",
    contactId: "contact-123",
    donorType: "person",
    firstName: "Jamie",
    lastName: "Donor",
    email: "jamie@example.org",
    phone: "9195550123",
    companyName: "Example Employer",
    paymentMethod: "card",
    isOffline: false,
    isRecurring: false,
    amount: 125,
    feeCovered: 3,
    currency: "USD",
    status: "succeeded",
    campaignId: "499886",
    campaignCode: "ABC123",
    campaignTitle: "PORCH Chapel Hill",
    createdAt: "2026-06-27T12:00:00.000Z",
    transactedAt: "2026-06-27T12:00:00.000Z",
    message: "Thank you",
    childTransactionCount: 1,
    hasFeeLineItem: true,
    dedication: {
      type: "In honor of",
      name: "A Friend",
      recipientName: "Recipient Name",
      recipientEmail: "recipient@example.org",
    },
    address: {
      company: "Example Employer",
      line1: "123 Main Street",
      line2: "Apt 2",
      city: "Chapel Hill",
      state: "NC",
      postalCode: "27516",
      country: "US",
    },
    utm: {
      referrer: "https://example.org",
      campaign: "summer",
      content: "button",
      medium: "email",
      source: "newsletter",
      term: "donate",
    },
    ...overrides,
  };
}
