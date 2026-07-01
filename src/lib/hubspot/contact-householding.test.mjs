import assert from "node:assert/strict";
import test from "node:test";

import { ensureContactHousehold } from "./contact-householding.ts";

test("creates and associates a Household for a new unmatched contact", async () => {
  const calls = [];
  const client = makeClient(calls);

  assert.deepEqual(await ensureContactHousehold(client, "contact-1"), {
    status: "created",
    contactId: "contact-1",
    companyId: "9001",
  });
  assert.equal(calls.filter(([name]) => name === "createCompany").length, 1);
  assert.ok(calls.some((call) => call.join("|") === "associateContactToCompany|contact-1|9001"));
  assert.ok(calls.some((call) =>
    call[0] === "updateContactProperties" && call[2].household_match_status === "auto_householded"));
});

test("is idempotent when the contact already has a Household", async () => {
  const calls = [];
  const client = makeClient(calls, {
    contact: {
      properties: { lastname: "Smith", household_match_status: "auto_householded" },
      associations: { companies: { results: [{ id: "existing" }] } },
    },
    companies: {
      existing: { id: "existing", properties: { name: "Smith Household", record_type: "household" } },
    },
  });

  assert.deepEqual(await ensureContactHousehold(client, "contact-1"), {
    status: "already_householded",
    contactId: "contact-1",
    companyId: "existing",
  });
  assert.equal(calls.some(([name]) => name === "createCompany"), false);
});

test("matches a strong existing Household instead of creating a duplicate", async () => {
  const calls = [];
  const existing = {
    id: "8001",
    properties: {
      name: "Smith Household",
      record_type: "household",
      address: "123 Main Street",
      zip: "27514",
    },
  };
  const client = makeClient(calls, { searchResults: [existing] });

  assert.deepEqual(await ensureContactHousehold(client, "contact-1"), {
    status: "matched",
    contactId: "contact-1",
    companyId: "8001",
  });
  assert.equal(calls.some(([name]) => name === "createCompany"), false);
});

test("sends contacts without a last name to Needs Review", async () => {
  const calls = [];
  const client = makeClient(calls, { contact: { properties: { firstname: "Anonymous", lastname: null } } });

  assert.deepEqual(await ensureContactHousehold(client, "contact-1"), {
    status: "needs_review",
    contactId: "contact-1",
    reason: "Contact has no last name.",
  });
  assert.ok(calls.some((call) =>
    call[0] === "updateContactProperties" && call[2].household_match_status === "needs_review"));
});

function makeClient(calls, overrides = {}) {
  const defaultContact = {
    id: "contact-1",
    properties: {
      firstname: "Jane",
      lastname: "Smith",
      email: "jane@gmail.com",
      address: "123 Main St",
      city: "Chapel Hill",
      state: "NC",
      zip: "27514",
    },
    associations: { companies: { results: [] } },
  };
  const contact = {
    ...defaultContact,
    ...overrides.contact,
    properties: { ...defaultContact.properties, ...overrides.contact?.properties },
  };
  const companies = overrides.companies ?? {};
  const searchResults = overrides.searchResults ?? [];

  return {
    async getContact(id) { calls.push(["getContact", id]); return { ...contact, id }; },
    async getCompany(id) { calls.push(["getCompany", id]); return companies[id]; },
    async searchCompanies(property, value) {
      calls.push(["searchCompanies", property, value]);
      return searchResults;
    },
    async createCompany(properties) {
      calls.push(["createCompany", properties]);
      return { id: "9001", properties };
    },
    async associateContactToCompany(contactId, companyId) {
      calls.push(["associateContactToCompany", contactId, companyId]);
    },
    async updateContactProperties(contactId, properties) {
      calls.push(["updateContactProperties", contactId, properties]);
    },
  };
}
