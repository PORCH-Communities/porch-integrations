/**
 * Second-pass household backfill: seeds the Needs Review queue in HubSpot.
 *
 * Targets the two groups that apply-household-backfill.mjs deliberately skipped:
 *   1. duplicate-risk shared-address groups (same last name, same address, but ambiguous first names)
 *   2. contacts with no last name (cannot be auto-householded)
 *
 * Dry-run by default. Pass --write to apply. Re-run safe: skips contacts
 * already at confirmed, auto_householded, or needs_review.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env scripts/backfill-needs-review.mjs [--write] [--out results.json]
 */

import { writeFileSync } from "node:fs";

import { normalizeLastName, normalizeStreet } from "../src/lib/householding/matching.ts";

const API = "https://api.hubapi.com";
const PIPELINES = ["155504019", "802960948", "806689671"];
const TERMINAL_STATUSES = new Set(["confirmed", "auto_householded", "needs_review"]);
const CONTACT_PROPERTIES = [
  "firstname", "lastname", "email", "address", "address2", "city", "state", "zip",
  "country", "household_match_status",
];

const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const args = process.argv.slice(2);
const write = args.includes("--write");
const outIndex = args.indexOf("--out");
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is required.");

// ── HubSpot helpers ──────────────────────────────────────────────────────────

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
      if (!response.ok) throw new Error(`${response.status} ${path}: ${(await response.text()).slice(0, 600)}`);
      return response.status === 204 ? null : response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, i) =>
    values.slice(i * size, i * size + size));
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

async function dealContactMap(dealIds) {
  const dealIdsByContact = new Map();
  for (const batch of chunks(dealIds, 100)) {
    const data = await api("/crm/v4/associations/deals/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({ inputs: batch.map((id) => ({ id })) }),
    });
    for (const result of data.results ?? []) {
      const dealId = String(result.from?.id ?? "");
      for (const assoc of result.to ?? []) {
        const contactId = String(assoc.toObjectId);
        const existing = dealIdsByContact.get(contactId) ?? [];
        existing.push(dealId);
        dealIdsByContact.set(contactId, existing);
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

// ── Grouping logic (mirrors audit-household-backfill.mjs) ────────────────────

function clean(value) { return value?.trim() || null; }
function titleCase(value) { return value.replace(/\b\p{L}/gu, (l) => l.toUpperCase()); }

function addressKey(contact) {
  const p = contact.properties;
  const street = normalizeStreet(p.address);
  return street
    ? [street, clean(p.city)?.toLowerCase(), clean(p.state)?.toLowerCase(), clean(p.zip)].join("|")
    : null;
}

function makeGroup(normalizedLastName, members) {
  const displayLastName = clean(members[0].properties.lastname) || titleCase(normalizedLastName);
  return {
    householdName: `${displayLastName} Household`,
    members: members.map((c) => ({
      id: c.id,
      name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" "),
      currentStatus: c.properties.household_match_status || null,
    })),
  };
}

function isDuplicateRisk(group) {
  const firstNames = group.members
    .map((m) => m.name.trim().toLowerCase().split(/\s+/)[0])
    .filter(Boolean);
  return new Set(firstNames).size < firstNames.length;
}

// ── Build work lists ──────────────────────────────────────────────────────────

console.error("[needs-review] fetching managed deals…");
const dealIds = (await Promise.all(PIPELINES.map(searchDealIds))).flat();
console.error(`[needs-review] managed deals=${dealIds.length}`);

const dealIdsByContact = await dealContactMap(dealIds);
const rawContacts = await readContacts([...dealIdsByContact.keys()]);
console.error(`[needs-review] donor contacts=${rawContacts.length}`);

const noLastNameContacts = rawContacts.filter((c) => !normalizeLastName(c.properties.lastname));

const eligible = rawContacts.filter((c) =>
  normalizeLastName(c.properties.lastname) &&
  !TERMINAL_STATUSES.has(c.properties.household_match_status));

const byLastName = new Map();
for (const c of eligible) {
  const key = normalizeLastName(c.properties.lastname);
  const group = byLastName.get(key) ?? [];
  group.push(c);
  byLastName.set(key, group);
}

const duplicateRiskGroups = [];
for (const [normalizedLastName, contactsInGroup] of byLastName) {
  const assigned = new Set();
  const byAddress = new Map();
  for (const c of contactsInGroup) {
    const key = addressKey(c);
    if (!key) continue;
    const addrGroup = byAddress.get(key) ?? [];
    addrGroup.push(c);
    byAddress.set(key, addrGroup);
  }
  for (const addrGroup of byAddress.values()) {
    if (addrGroup.length < 2) continue;
    const group = makeGroup(normalizedLastName, addrGroup);
    if (isDuplicateRisk(group)) {
      addrGroup.forEach(({ id }) => assigned.add(id));
      duplicateRiskGroups.push(group);
    }
  }
}

// Contacts that are in a duplicate-risk shared-address group
const duplicateRiskContactIds = new Set(
  duplicateRiskGroups.flatMap((g) => g.members.map((m) => m.id))
);

// No-last-name contacts not already at a terminal status
const noLastNamePending = noLastNameContacts.filter(
  (c) => !TERMINAL_STATUSES.has(c.properties.household_match_status)
);

console.error(
  `[needs-review] duplicate-risk groups=${duplicateRiskGroups.length} ` +
  `contacts=${duplicateRiskContactIds.size} | ` +
  `no-last-name pending=${noLastNamePending.length}`
);

// ── Dry-run output ────────────────────────────────────────────────────────────

if (!write) {
  const preview = {
    mode: "dry-run",
    duplicateRiskGroups: duplicateRiskGroups.length,
    duplicateRiskContacts: duplicateRiskContactIds.size,
    noLastNameContacts: noLastNamePending.length,
    totalContactsToMark: duplicateRiskContactIds.size + noLastNamePending.length,
    groups: duplicateRiskGroups.map((g) => ({
      householdName: g.householdName,
      members: g.members,
    })),
    noLastName: noLastNamePending.map((c) => ({
      id: c.id,
      name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || "(no name)",
      email: c.properties.email || null,
      currentStatus: c.properties.household_match_status || null,
    })),
    applyCommand:
      `node --experimental-strip-types --env-file=.env scripts/backfill-needs-review.mjs --write` +
      (outFile ? ` --out ${outFile}` : ""),
  };
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}

// ── Write pass ────────────────────────────────────────────────────────────────

async function markNeedsReview(contactId, props) {
  await api(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: props }),
  });
}

const results = [];

// Duplicate-risk contacts: point them at the suggested household, score 80
for (const group of duplicateRiskGroups) {
  for (const member of group.members) {
    try {
      await markNeedsReview(member.id, {
        household_match_status: "needs_review",
        suggested_household_match: group.householdName,
        household_match_score: "80",
      });
      results.push({ ok: true, contactId: member.id, name: member.name, reason: "duplicate_risk", householdName: group.householdName });
    } catch (error) {
      results.push({ ok: false, contactId: member.id, name: member.name, reason: "duplicate_risk", error: error instanceof Error ? error.message : "Unknown error" });
    }
  }
}

// No-last-name contacts: flag for review with no suggestion
for (const contact of noLastNamePending) {
  const name = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(" ") || "(no name)";
  try {
    await markNeedsReview(contact.id, {
      household_match_status: "needs_review",
      suggested_household_match: "",
      household_match_score: "0",
    });
    results.push({ ok: true, contactId: contact.id, name, reason: "no_last_name" });
  } catch (error) {
    results.push({ ok: false, contactId: contact.id, name, reason: "no_last_name", error: error instanceof Error ? error.message : "Unknown error" });
  }
}

const summary = {
  mode: "write",
  succeeded: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  byReason: {
    duplicate_risk: results.filter((r) => r.reason === "duplicate_risk" && r.ok).length,
    no_last_name: results.filter((r) => r.reason === "no_last_name" && r.ok).length,
  },
};

console.log(JSON.stringify(summary, null, 2));
if (outFile) writeFileSync(outFile, JSON.stringify({ ...summary, results }, null, 2));
if (summary.failed > 0) process.exitCode = 1;
