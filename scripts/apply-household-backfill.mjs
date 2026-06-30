/**
 * Applies a reviewed report from audit-household-backfill.mjs.
 * Dry-run by default. Write requires both --write and --confirm <ready count>.
 * Review-required groups are never written.
 */

import { readFileSync, writeFileSync } from "node:fs";

const API = "https://api.hubapi.com";
const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const args = process.argv.slice(2);
const reportPath = valueAfter("--report");
const resultPath = valueAfter("--out");
const write = args.includes("--write");
const confirm = Number(valueAfter("--confirm"));
const offset = Number(valueAfter("--offset") ?? 0);
const limit = Number(valueAfter("--limit") ?? Number.POSITIVE_INFINITY);

if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is required.");
if (!reportPath) throw new Error("--report <audit.json> is required.");

const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (report.mode !== "dry-run" || report.scope !== "managed-pipeline donation history") {
  throw new Error("Refusing an unrecognized audit report.");
}
const ready = report.households.filter((household) => !household.reviewRequired);
if (ready.length !== report.summary.readyHouseholds) {
  throw new Error("Report ready count does not reconcile.");
}
if (write && confirm !== ready.length) {
  throw new Error(`Write requires --confirm ${ready.length}.`);
}
const selected = ready.slice(offset, offset + limit);

console.error(`[household-apply] mode=${write ? "write" : "dry-run"} ready=${ready.length} selected=${selected.length} offset=${offset} held=${report.households.length - ready.length}`);

if (!write) {
  const preview = {
    mode: "dry-run",
    wouldCreate: ready.length,
    singletonHouseholds: ready.filter(({ kind }) => kind === "singleton").length,
    sharedAddressHouseholds: ready.filter(({ kind }) => kind === "shared_address").length,
    withStreetAddress: ready.filter(({ mailingAddress }) => mailingAddress.address).length,
    withoutStreetAddress: ready.filter(({ mailingAddress }) => !mailingAddress.address).length,
    contactsToAssociate: ready.reduce((total, household) => total + household.members.length, 0),
    dealsToAssociate: new Set(ready.flatMap(({ members }) => members.flatMap(({ dealIds }) => dealIds))).size,
    applyCommand: `node --experimental-strip-types --env-file=.env scripts/apply-household-backfill.mjs --report ${reportPath} --write --confirm ${ready.length}`,
  };
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}

const results = [];
for (const [index, household] of selected.entries()) {
  try {
    const existing = await findExistingHousehold(household);
    const company = existing ?? await createCompany(household);
    for (const member of household.members) {
      await associate("contacts", member.id, "companies", company.id);
      for (const dealId of member.dealIds ?? []) {
        await associate("deals", dealId, "companies", company.id);
      }
      await api(`/crm/v3/objects/contacts/${encodeURIComponent(member.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: {
          household_match_status: "auto_householded",
          suggested_household_match: `${company.id} | ${household.householdName}`,
          household_match_score: "100",
        } }),
      });
    }
    results.push({ ok: true, companyId: company.id, reused: Boolean(existing), householdName: household.householdName, memberIds: household.members.map(({ id }) => id) });
  } catch (error) {
    results.push({ ok: false, householdName: household.householdName, memberIds: household.members.map(({ id }) => id), error: error instanceof Error ? error.message : "Unknown error" });
  }
  if ((index + 1) % 10 === 0) console.error(`[household-apply] ${index + 1}/${selected.length}`);
}

const output = { generatedAt: new Date().toISOString(), mode: "write", summary: {
  succeeded: results.filter(({ ok }) => ok).length,
  failed: results.filter(({ ok }) => !ok).length,
  reused: results.filter(({ reused }) => reused).length,
}, results };
console.log(JSON.stringify(output.summary, null, 2));
if (resultPath) writeFileSync(resultPath, JSON.stringify(output, null, 2));
if (output.summary.failed) process.exitCode = 1;

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

async function api(path, init = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(20_000), headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers,
      } });
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

async function findExistingHousehold(household) {
  const associatedHouseholds = [];
  for (const member of household.members) {
    const associations = await api(`/crm/v4/objects/contacts/${encodeURIComponent(member.id)}/associations/companies?limit=100`);
    for (const association of associations.results ?? []) {
      const company = await api(`/crm/v3/objects/companies/${encodeURIComponent(association.toObjectId)}?properties=name,address,record_type`);
      if (company.properties.record_type === "household") associatedHouseholds.push(company);
    }
  }
  const uniqueAssociated = [...new Map(associatedHouseholds.map((company) => [company.id, company])).values()];
  if (uniqueAssociated.length > 1) throw new Error("Members are already associated with multiple Households.");
  if (uniqueAssociated.length === 1) return uniqueAssociated[0];

  if (!household.mailingAddress.address) return null;
  const data = await api("/crm/v3/objects/companies/search", { method: "POST", body: JSON.stringify({
    filterGroups: [{ filters: [
      { propertyName: "record_type", operator: "EQ", value: "household" },
      { propertyName: "name", operator: "EQ", value: household.householdName },
      { propertyName: "address", operator: "EQ", value: household.mailingAddress.address },
    ] }], properties: ["name", "address", "record_type"], limit: 2,
  }) });
  if ((data.results ?? []).length > 1) throw new Error("Multiple existing Households match name/address.");
  return data.results?.[0] ?? null;
}

async function createCompany(household) {
  return api("/crm/v3/objects/companies", { method: "POST", body: JSON.stringify({ properties: {
    name: household.householdName,
    envelope_name: household.envelopeName,
    record_type: "household",
    ...household.mailingAddress,
  } }) });
}

async function associate(fromType, fromId, toType, toId) {
  await api(`/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/default/${toType}/${encodeURIComponent(toId)}`, { method: "PUT" });
}
