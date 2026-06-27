import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmContactHousehold,
  parseSuggestedHouseholdCompanyId,
} from "./household-confirmation.ts";

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
        { id: "donation-deal", properties: { pipeline: "155504019" } },
        { id: "other-deal", properties: { pipeline: "other-pipeline" } },
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
