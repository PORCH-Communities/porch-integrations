import assert from "node:assert/strict";
import test from "node:test";

import {
  findHouseholdCompanies,
  processDonationHouseholdMatch,
} from "./household-matching.ts";

test("finds Household companies by canonical name and address and deduplicates them", async () => {
  const calls = [];
  const household = makeHousehold();
  const client = {
    async searchCompanies(propertyName, value, properties) {
      calls.push([propertyName, value, properties]);

      if (propertyName === "name") {
        return [household, makeCompany({ id: "business", record_type: "organization" })];
      }

      return [household];
    },
  };

  const candidates = await findHouseholdCompanies(client, makeDonation());

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    hubspotCompanyId: "household-1",
    householdName: "Smith Household",
    lastName: "smith",
    street: "123 Main St",
    zip: "27516",
    email: "member@porch.org",
  });
  assert.deepEqual(
    calls.map(([propertyName, value]) => [propertyName, value]),
    [
      ["name", "Smith Household"],
      ["address", "123 Main Street"],
    ],
  );
});

test("auto-households a strong match and associates both contact and deal", async () => {
  const calls = [];
  const client = makeClient(calls, [makeHousehold()]);

  const result = await processDonationHouseholdMatch(client, {
    donation: makeDonation(),
    contactId: "contact-1",
    dealId: "deal-1",
    mode: "write",
  });

  assert.equal(result.status, "matched");
  assert.equal(result.match.decision, "auto_household");
  assert.ok(
    calls.some(
      ([name, id, properties]) =>
        name === "updateContactProperties" &&
        id === "contact-1" &&
        properties.household_match_status === "auto_householded" &&
        properties.suggested_household_match === "household-1 | Smith Household" &&
        properties.household_match_score === "105",
    ),
  );
  assert.ok(calls.some((call) => call.join("|") === "associateContactToCompany|contact-1|household-1"));
  assert.ok(calls.some((call) => call.join("|") === "associateDealToCompany|deal-1|household-1"));
});

test("queues a last-name-only candidate for review without associations", async () => {
  const calls = [];
  const client = makeClient(calls, [
    makeHousehold({ address: "900 Other Rd", zip: "99999", email: null }),
  ]);

  const result = await processDonationHouseholdMatch(client, {
    donation: makeDonation(),
    contactId: "contact-1",
    dealId: "deal-1",
    mode: "write",
  });

  assert.equal(result.status, "matched");
  assert.equal(result.match.decision, "needs_review");
  assert.ok(
    calls.some(
      ([name, , properties]) =>
        name === "updateContactProperties" &&
        properties.household_match_status === "needs_review" &&
        properties.household_match_score === "40",
    ),
  );
  assert.equal(calls.some(([name]) => name.startsWith("associate")), false);
});

test("records no match when no Household company exists", async () => {
  const calls = [];
  const client = makeClient(calls, []);

  const result = await processDonationHouseholdMatch(client, {
    donation: makeDonation(),
    contactId: "contact-1",
    dealId: "deal-1",
    mode: "write",
  });

  assert.equal(result.status, "matched");
  assert.equal(result.match.decision, "no_match");
  assert.ok(
    calls.some(
      ([name, , properties]) =>
        name === "updateContactProperties" &&
        properties.household_match_status === "no_match" &&
        properties.suggested_household_match === "",
    ),
  );
});

test("does not rematch terminal staff decisions or organization donors", async () => {
  for (const input of [
    { existingStatus: "confirmed", donation: makeDonation() },
    { existingStatus: null, donation: makeDonation({ donorType: "organization" }) },
  ]) {
    const calls = [];
    const result = await processDonationHouseholdMatch(makeClient(calls, [makeHousehold()]), {
      ...input,
      contactId: "contact-1",
      dealId: "deal-1",
      mode: "write",
    });

    assert.equal(result.status, "skipped");
    assert.deepEqual(calls, []);
  }
});

test("shadow mode scores candidates without mutating HubSpot", async () => {
  const calls = [];
  const result = await processDonationHouseholdMatch(makeClient(calls, [makeHousehold()]), {
    donation: makeDonation(),
    contactId: null,
    dealId: null,
    mode: "shadow",
  });

  assert.equal(result.status, "matched");
  assert.equal(result.match.decision, "auto_household");
  assert.equal(calls.some(([name]) => name !== "searchCompanies"), false);
});

function makeClient(calls, companies) {
  return {
    async searchCompanies(propertyName, value) {
      calls.push(["searchCompanies", propertyName, value]);
      return companies;
    },
    async updateContactProperties(id, properties) {
      calls.push(["updateContactProperties", id, properties]);
    },
    async associateContactToCompany(contactId, companyId) {
      calls.push(["associateContactToCompany", contactId, companyId]);
    },
    async associateDealToCompany(dealId, companyId) {
      calls.push(["associateDealToCompany", dealId, companyId]);
    },
  };
}

function makeHousehold(overrides = {}) {
  return makeCompany({
    id: "household-1",
    name: "Smith Household",
    record_type: "household",
    address: "123 Main St",
    zip: "27516",
    email: "member@porch.org",
    ...overrides,
  });
}

function makeCompany({ id, ...properties }) {
  return { id, properties };
}

function makeDonation(overrides = {}) {
  return {
    donorType: "person",
    firstName: "Jamie",
    lastName: "Smith",
    email: "jamie@example.org",
    address: {
      line1: "123 Main Street",
      postalCode: "27516",
    },
    ...overrides,
  };
}
