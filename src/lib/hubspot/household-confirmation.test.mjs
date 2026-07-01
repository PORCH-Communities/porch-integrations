import assert from "node:assert/strict";
import test from "node:test";

import {
  associateGivebutterDealToHousehold,
  confirmContactHousehold,
  parseSuggestedHouseholdCompanyId,
  processHouseholdReviewAction,
  processHouseholdStatusChange,
} from "./household-confirmation.ts";

test("creates a Household for an unhouseholded contact without review fields", async () => {
  const calls = [];
  let contactProperties = { lastname: "Youd", address: "1 Main St", city: "Chapel Hill", state: "NC", zip: "27514" };
  const client = {
    async getContact(id) {
      return {
        id,
        properties: contactProperties,
        associations: { deals: { results: [] }, companies: { results: [] } },
      };
    },
    async createCompany(properties) {
      calls.push(["createCompany", properties]);
      return { id: "123456", properties };
    },
    async associateContactToCompany(contactId, companyId) {
      calls.push(["associateContactToCompany", contactId, companyId]);
    },
    async updateContactProperties(contactId, properties) {
      calls.push(["updateContactProperties", contactId, properties]);
      contactProperties = { ...contactProperties, ...properties };
    },
    async getCompany(id) {
      return { id, properties: { name: "Youd Household", record_type: "household" } };
    },
    async getDeals() { return []; },
    async associateDealToCompany() {},
  };

  const result = await processHouseholdReviewAction(client, "contact-new", "save_new_household");

  assert.deepEqual(result, {
    status: "associated",
    contactId: "contact-new",
    companyId: "123456",
    associatedDealIds: [],
  });
  assert.ok(calls.some(([name]) => name === "createCompany"));
});

test("recreates a Household when a stale auto-householded status has no association", async () => {
  const calls = [];
  let contactProperties = { lastname: "Youd", household_match_status: "auto_householded" };
  const client = {
    async getContact(id) {
      return { id, properties: contactProperties, associations: { companies: { results: [] }, deals: { results: [] } } };
    },
    async createCompany(properties) { calls.push(["createCompany", properties]); return { id: "123456", properties }; },
    async associateContactToCompany(contactId, companyId) { calls.push(["associateContactToCompany", contactId, companyId]); },
    async updateContactProperties(contactId, properties) { contactProperties = { ...contactProperties, ...properties }; },
    async getCompany(id) { return { id, properties: { name: "Youd Household", record_type: "household" } }; },
    async getDeals() { return []; },
    async associateDealToCompany() {},
  };

  assert.equal(
    (await processHouseholdReviewAction(client, "contact-stale", "save_new_household")).status,
    "associated",
  );
  assert.equal(calls.filter(([name]) => name === "createCompany").length, 1);
});

test("associates a confirmed contact and only Individual Donations deals", async () => {
  const calls = [];
  const client = {
    async getContact(id) {
      calls.push(["getContact", id]);
      return {
        id,
        properties: {
          household_match_status: "confirmed",
          suggested_household_match: "56107880716 | Baxley Household",
        },
        associations: {
          deals: { results: [{ id: "donation-deal" }, { id: "other-deal" }] },
        },
      };
    },
    async getCompany(id) {
      calls.push(["getCompany", id]);
      return { id, properties: { name: "Baxley Household", record_type: "household" } };
    },
    async getDeals(ids) {
      calls.push(["getDeals", ids]);
      return [
        { id: "donation-deal", properties: { pipeline: "155504019", givebutter_transaction_id: "txn-1", givebutter_reference_number: null } },
        { id: "other-deal", properties: { pipeline: "other-pipeline", givebutter_transaction_id: null, givebutter_reference_number: null } },
      ];
    },
    async associateContactToCompany(contactId, companyId) {
      calls.push(["associateContactToCompany", contactId, companyId]);
    },
    async associateDealToCompany(dealId, companyId) {
      calls.push(["associateDealToCompany", dealId, companyId]);
    },
  };

  const result = await confirmContactHousehold(client, "contact-laura");

  assert.deepEqual(result, {
    status: "associated",
    contactId: "contact-laura",
    companyId: "56107880716",
    associatedDealIds: ["donation-deal"],
  });
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "associateContactToCompany" &&
        call[1] === "contact-laura" &&
        call[2] === "56107880716",
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "associateDealToCompany" &&
        call[1] === "donation-deal" &&
        call[2] === "56107880716",
    ),
  );
  assert.equal(calls.some((call) => call[1] === "other-deal"), false);
});

test("ignores a stale confirmation event when the contact is no longer confirmed", async () => {
  const client = {
    async getContact(id) {
      return { id, properties: { household_match_status: "needs_review" } };
    },
    async getCompany() {
      throw new Error("should not be called");
    },
    async getDeals() {
      throw new Error("should not be called");
    },
    async associateContactToCompany() {
      throw new Error("should not be called");
    },
    async associateDealToCompany() {
      throw new Error("should not be called");
    },
  };

  assert.deepEqual(await confirmContactHousehold(client, "contact-laura"), {
    status: "ignored_not_confirmed",
    contactId: "contact-laura",
    reason: "Contact is no longer confirmed.",
  });
});

test("requires a valid Household company before creating associations", async () => {
  const client = {
    async getContact(id) {
      return {
        id,
        properties: {
          household_match_status: "confirmed",
          suggested_household_match: "123 | Not a Household",
        },
      };
    },
    async getCompany(id) {
      return { id, properties: { name: "Business", record_type: "organization" } };
    },
    async getDeals() {
      return [];
    },
    async associateContactToCompany() {
      throw new Error("should not be called");
    },
    async associateDealToCompany() {
      throw new Error("should not be called");
    },
  };

  assert.deepEqual(await confirmContactHousehold(client, "contact-laura"), {
    status: "needs_attention",
    contactId: "contact-laura",
    reason: "Suggested company is not marked as a Household.",
  });
});

test("parses the leading HubSpot company ID from the suggested match", () => {
  assert.equal(
    parseSuggestedHouseholdCompanyId("56107880716 | Baxley Household"),
    "56107880716",
  );
  assert.equal(parseSuggestedHouseholdCompanyId("Baxley Household"), null);
  assert.equal(parseSuggestedHouseholdCompanyId(null), null);
});

test("uses one staff-associated Household when a confirmed contact has no suggestion", async () => {
  const calls = [];
  const client = {
    async getContact(id) {
      return {
        id,
        properties: { household_match_status: "confirmed" },
        associations: {
          companies: { results: [{ id: "business" }, { id: "new-household" }] },
        },
      };
    },
    async getCompany(id) {
      return {
        id,
        properties: { record_type: id === "new-household" ? "household" : "organization" },
      };
    },
    async getDeals() {
      return [];
    },
    async associateContactToCompany(contactId, companyId) {
      calls.push(["associateContactToCompany", contactId, companyId]);
    },
    async associateDealToCompany() {},
  };

  assert.deepEqual(await confirmContactHousehold(client, "contact-new"), {
    status: "associated",
    contactId: "contact-new",
    companyId: "new-household",
    associatedDealIds: [],
  });
  assert.deepEqual(calls, [["associateContactToCompany", "contact-new", "new-household"]]);
});

test("stops when a contact is associated with multiple Households", async () => {
  const client = {
    async getContact(id) {
      return {
        id,
        properties: { household_match_status: "confirmed" },
        associations: {
          companies: { results: [{ id: "household-1" }, { id: "household-2" }] },
        },
      };
    },
    async getCompany(id) {
      return { id, properties: { record_type: "household" } };
    },
    async getDeals() {
      throw new Error("should not be called");
    },
    async associateContactToCompany() {
      throw new Error("should not be called");
    },
    async associateDealToCompany() {
      throw new Error("should not be called");
    },
  };

  assert.deepEqual(await confirmContactHousehold(client, "contact-ambiguous"), {
    status: "needs_attention",
    contactId: "contact-ambiguous",
    reason: "Contact is associated with multiple Household companies.",
  });
});

test("clears stale review fields when the current status is No Match", async () => {
  const updates = [];
  const client = {
    async getContact(id) {
      return { id, properties: { household_match_status: "no_match" } };
    },
    async updateContactProperties(id, properties) {
      updates.push([id, properties]);
    },
  };

  assert.deepEqual(await processHouseholdStatusChange(client, "contact-no-match"), {
    status: "review_fields_cleared",
    contactId: "contact-no-match",
  });
  assert.deepEqual(updates, [
    [
      "contact-no-match",
      { suggested_household_match: "", household_match_score: "" },
    ],
  ]);
});

test("associates a Givebutter donation deal to a confirmed contact's Household", async () => {
  const associations = [];
  const client = {
    async getDeal(id) {
      return {
        id,
        properties: {
          pipeline: "155504019",
          givebutter_reference_number: "123456",
        },
        associations: { contacts: { results: [{ id: "contact-1" }] } },
      };
    },
    async getContact(id) {
      return {
        id,
        properties: { household_match_status: "confirmed" },
        associations: { companies: { results: [{ id: "household-1" }] } },
      };
    },
    async getCompany(id) {
      return { id, properties: { record_type: "household" } };
    },
    async associateDealToCompany(dealId, companyId) {
      associations.push([dealId, companyId]);
    },
  };

  assert.deepEqual(await associateGivebutterDealToHousehold(client, "deal-1"), {
    status: "associated",
    dealId: "deal-1",
    companyId: "household-1",
  });
  assert.deepEqual(associations, [["deal-1", "household-1"]]);
});

test("ignores non-Givebutter and non-donation deals", async () => {
  const makeClient = (properties) => ({
    async getDeal(id) {
      return { id, properties, associations: { contacts: { results: [{ id: "contact-1" }] } } };
    },
  });

  // No Givebutter identifier at all — ignore regardless of pipeline.
  assert.deepEqual(
    await associateGivebutterDealToHousehold(
      makeClient({ pipeline: "155504019", givebutter_transaction_id: null, givebutter_reference_number: null }),
      "deal-no-reference",
    ),
    {
      status: "ignored",
      dealId: "deal-no-reference",
      reason: "Deal has no Givebutter identifier (not a Vercel-created donation deal).",
    },
  );

  // A deal in any pipeline WITH a Givebutter key is now eligible (pipeline guard removed).
  // It should reach contact lookup, not be silently ignored.
  const clientWithContact = {
    async getDeal(id) {
      return {
        id,
        properties: { pipeline: "802960948", givebutter_transaction_id: null, givebutter_reference_number: "123" },
        associations: { contacts: { results: [{ id: "contact-1" }] } },
      };
    },
    async getContact(id) {
      // Contact has no confirmed household — so it falls through to "no confirmed contact" ignored.
      return { id, properties: { household_match_status: "needs_review" }, associations: { companies: { results: [] } } };
    },
    async getCompany(id) {
      return { id, properties: { record_type: "household" } };
    },
  };
  const result = await associateGivebutterDealToHousehold(clientWithContact, "deal-grant-pipeline");
  // contact-1 has no confirmed household, so it will be ignored (no confirmed contact)
  assert.equal(result.status, "ignored");
  assert.equal(result.dealId, "deal-grant-pipeline");
  assert.ok(result.reason.includes("No associated contact has a confirmed household"));
});

test("does not recreate an existing household deal association", async () => {
  const client = {
    async getDeal(id) {
      return {
        id,
        properties: { pipeline: "155504019", givebutter_reference_number: "123" },
        associations: {
          contacts: { results: [{ id: "contact-1" }] },
          companies: { results: [{ id: "household-1" }] },
        },
      };
    },
    async getContact(id) {
      return {
        id,
        properties: { household_match_status: "auto_householded" },
        associations: { companies: { results: [{ id: "household-1" }] } },
      };
    },
    async getCompany(id) {
      return { id, properties: { record_type: "household" } };
    },
    async associateDealToCompany() {
      throw new Error("should not be called");
    },
  };

  assert.deepEqual(await associateGivebutterDealToHousehold(client, "deal-existing"), {
    status: "already_associated",
    dealId: "deal-existing",
    companyId: "household-1",
  });
});
