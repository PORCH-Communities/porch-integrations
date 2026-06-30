/**
 * Dry-run inventory for donor-only Household creation.
 * No HubSpot writes. Donation history means association with a deal in one of
 * the three managed fundraising pipelines.
 *
 * Usage:
 *   node --env-file=.env scripts/audit-household-backfill.mjs [--out report.json]
 */

import { writeFileSync } from "node:fs";

import { normalizeLastName, normalizeStreet } from "../src/lib/householding/matching.ts";

const API = "https://api.hubapi.com";
const PIPELINES = ["155504019", "802960948", "806689671"];
const CONTACT_PROPERTIES = [
  "firstname", "lastname", "email", "address", "address2", "city", "state", "zip",
  "country", "household_match_status",
];
const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex >= 0 ? process.argv[outIndex + 1] : null;

if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is required.");

async function api(path, init = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, {
        ...init,
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${path}: ${(await response.text()).slice(0, 800)}`);
      return response.status === 204 ? null : response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

async function searchDealIds(pipeline) {
  const ids = [];
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: "pipeline", operator: "EQ", value: pipeline }] }],
      properties: ["pipeline"],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const page = await api("/crm/v3/objects/deals/search", { method: "POST", body: JSON.stringify(body) });
    ids.push(...(page.results ?? []).map(({ id }) => id));
    after = page.paging?.next?.after;
  } while (after);
  return ids;
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, index * size + size));
}

async function donorContactIds(dealIds) {
  const dealIdsByContact = new Map();
  for (const batch of chunks(dealIds, 100)) {
    const data = await api("/crm/v4/associations/deals/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({ inputs: batch.map((id) => ({ id })) }),
    });
    for (const result of data.results ?? []) {
      const dealId = String(result.from?.id ?? "");
      for (const association of result.to ?? []) {
        const contactId = String(association.toObjectId);
        const contactDeals = dealIdsByContact.get(contactId) ?? [];
        contactDeals.push(dealId);
        dealIdsByContact.set(contactId, contactDeals);
      }
    }
  }
  return dealIdsByContact;
}

async function readContacts(ids) {
  const contacts = [];
  for (const batch of chunks(ids, 100)) {
    const data = await api("/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({ properties: CONTACT_PROPERTIES, inputs: batch.map((id) => ({ id })) }),
    });
    contacts.push(...(data.results ?? []));
  }
  return contacts;
}

function clean(value) { return value?.trim() || null; }
function titleCase(value) { return value.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()); }
function addressKey(contact) {
  const p = contact.properties;
  const street = normalizeStreet(p.address);
  return street ? [street, clean(p.city)?.toLowerCase(), clean(p.state)?.toLowerCase(), clean(p.zip)].join("|") : null;
}
function mailingAddress(contact) {
  const p = contact.properties;
  return Object.fromEntries(Object.entries({
    address: clean(p.address), address2: clean(p.address2), city: clean(p.city),
    state: clean(p.state), zip: clean(p.zip), country: clean(p.country),
  }).filter(([, value]) => value));
}
function member(contact) {
  const p = contact.properties;
  return {
    id: contact.id,
    name: [p.firstname, p.lastname].filter(Boolean).join(" "),
    email: p.email || null,
    dealIds: contact.dealIds ?? [],
  };
}

const dealIds = (await Promise.all(PIPELINES.map(searchDealIds))).flat();
console.error(`[household-audit] managed deals=${dealIds.length}`);
const dealIdsByContact = await donorContactIds(dealIds);
const contacts = (await readContacts([...dealIdsByContact.keys()])).map((contact) => ({
  ...contact,
  dealIds: dealIdsByContact.get(contact.id) ?? [],
}));
const alreadyHouseholded = contacts.filter(({ properties: p }) =>
  p.household_match_status === "confirmed" || p.household_match_status === "auto_householded");
const eligible = contacts.filter(({ properties: p }) =>
  normalizeLastName(p.lastname) && p.household_match_status !== "confirmed" && p.household_match_status !== "auto_householded");
const noLastName = contacts.filter(({ properties: p }) => !normalizeLastName(p.lastname));

const byLastName = new Map();
for (const contact of eligible) {
  const key = normalizeLastName(contact.properties.lastname);
  const group = byLastName.get(key) ?? [];
  group.push(contact);
  byLastName.set(key, group);
}

const households = [];
for (const [normalizedLastName, contactsWithLastName] of byLastName) {
  const assigned = new Set();
  const byAddress = new Map();
  for (const contact of contactsWithLastName) {
    const key = addressKey(contact);
    if (!key) continue;
    const group = byAddress.get(key) ?? [];
    group.push(contact);
    byAddress.set(key, group);
  }
  for (const group of byAddress.values()) {
    if (group.length < 2) continue;
    group.forEach(({ id }) => assigned.add(id));
    households.push(makeHousehold(normalizedLastName, group, "shared_address"));
  }
  for (const contact of contactsWithLastName) {
    if (!assigned.has(contact.id)) households.push(makeHousehold(normalizedLastName, [contact], "singleton"));
  }
}

function makeHousehold(normalizedLastName, members) {
  const displayLastName = clean(members[0].properties.lastname) || titleCase(normalizedLastName);
  const addressSource = members.find((contact) => clean(contact.properties.address)) ?? members[0];
  return {
    householdName: `${displayLastName} Household`,
    envelopeName: `The ${displayLastName} Family`,
    kind: members.length === 1 ? "singleton" : "shared_address",
    mailingAddress: mailingAddress(addressSource),
    members: members.map(member),
  };
}

const duplicateRisks = households.filter((household) => {
  const keys = household.members
    .map((item) => item.name.trim().toLowerCase().split(/\s+/)[0])
    .filter(Boolean);
  return new Set(keys).size < keys.length;
});
for (const household of households) {
  household.reviewRequired = duplicateRisks.includes(household);
}
const summary = {
  managedDeals: dealIds.length,
  uniqueDonorContacts: contacts.length,
  alreadyHouseholded: alreadyHouseholded.length,
  eligibleContacts: eligible.length,
  noLastName: noLastName.length,
  plannedHouseholds: households.length,
  sharedAddressHouseholds: households.filter(({ kind }) => kind === "shared_address").length,
  singletonHouseholds: households.filter(({ kind }) => kind === "singleton").length,
  householdsWithStreetAddress: households.filter(({ mailingAddress }) => mailingAddress.address).length,
  householdsWithoutStreetAddress: households.filter(({ mailingAddress }) => !mailingAddress.address).length,
  duplicateRiskHouseholds: duplicateRisks.length,
  readyHouseholds: households.length - duplicateRisks.length,
};
const report = { generatedAt: new Date().toISOString(), mode: "dry-run", scope: "managed-pipeline donation history", summary, households, noLastName: noLastName.map(member) };
console.log(JSON.stringify(summary, null, 2));
if (outFile) {
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.error(`[household-audit] report=${outFile}`);
}
