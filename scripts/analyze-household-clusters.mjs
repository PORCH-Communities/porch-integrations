/**
 * Pre-analysis dry run for household clustering.
 *
 * Pages through all HubSpot contacts, clusters them by normalized last name,
 * scores contacts within each cluster against each other, and prints a summary
 * report. No HubSpot reads of companies, no writes of any kind.
 *
 * Usage:
 *   node --experimental-strip-types --env-file=.env scripts/analyze-household-clusters.mjs [options]
 *
 * Options:
 *   --limit <n>    Cap on total contacts to fetch (default: all)
 *   --out <file>   Write full JSON report to a file in addition to the summary
 *   --md <file>    Write a markdown summary report to a file
 */

import { writeFileSync } from "node:fs";

import {
  normalizeLastName,
  normalizeStreet,
  normalizeZip,
  getEmailDomain,
  scoreHouseholdCandidate,
} from "../src/lib/householding/matching.ts";

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const outArg = args.indexOf("--out");

const mdArg = args.indexOf("--md");

const CONTACT_LIMIT = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;
const OUT_FILE = outArg !== -1 ? args[outArg + 1] : null;
const MD_FILE = mdArg !== -1 ? args[mdArg + 1] : null;

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
];

// ─── HubSpot paging ──────────────────────────────────────────────────────────

async function fetchAllContacts() {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");

  const contacts = [];
  let after = undefined;
  let page = 0;

  while (contacts.length < CONTACT_LIMIT) {
    page += 1;
    const pageSize = Math.min(100, CONTACT_LIMIT - contacts.length);

    const body = {
      filterGroups: [
        { filters: [{ propertyName: "lastname", operator: "HAS_PROPERTY" }] },
      ],
      properties: CONTACT_PROPERTIES,
      limit: pageSize,
    };
    if (after) body.after = after;

    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HubSpot contacts search failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    const batch = data.results ?? [];
    contacts.push(...batch);

    process.stderr.write(`  page ${page}: ${batch.length} contacts (total ${contacts.length})\n`);

    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;

    // CRM search endpoint allows ~4 req/sec; stay safely under
    await new Promise((r) => setTimeout(r, 300));
  }

  return contacts;
}

// ─── Contact → matchable shape ───────────────────────────────────────────────

function toMatchable(contact) {
  const p = contact.properties;
  return {
    id: contact.id,
    firstName: p.firstname ?? null,
    lastName: p.lastname ?? null,
    email: p.email ?? null,
    street: p.address ?? null,
    zip: p.zip ?? null,
    existingStatus: p.household_match_status ?? null,
  };
}

// ─── Clustering ───────────────────────────────────────────────────────────────

function clusterByLastName(contacts) {
  const clusters = new Map();

  for (const c of contacts) {
    const key = normalizeLastName(c.lastName);
    if (!key) continue;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(c);
  }

  return clusters;
}

// Score contact A against contact B (contact-to-contact, not contact-to-household).
// We treat B as a HouseholdCandidate by adding the required fields.
function scoreContactPair(a, b) {
  const candidate = {
    ...b,
    hubspotCompanyId: b.id,
    householdName: `${b.lastName} Household`,
  };
  return scoreHouseholdCandidate(a, candidate);
}

// Within a last-name cluster, find address-confirmed sub-clusters and all
// scored pairs. Returns { subClusters, reviewPairs } where:
//   subClusters — groups of 2–4 contacts connected by street-address signal
//   reviewPairs — pairs scoring 40–79 (ZIP/email only, no street match)
function analyzeCluster(members) {
  if (members.length < 2) return { subClusters: [], reviewPairs: [] };

  const addressEdges = [];  // score ≥ 80 AND street signal — safe to union
  const reviewPairs = [];   // score 40–79, or ≥ 80 without street — needs review

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const result = scoreContactPair(members[i], members[j]);
      if (result.score < 40) continue;

      const hasStreet = result.signals.includes("street");

      if (result.score >= 80 && hasStreet) {
        addressEdges.push({ a: i, b: j, score: result.score, signals: result.signals });
      } else {
        reviewPairs.push({
          a: members[i],
          b: members[j],
          score: result.score,
          signals: result.signals,
        });
      }
    }
  }

  // Union-find only on address-confirmed edges — prevents transitive chaining
  // across unrelated contacts who merely share a last name and ZIP
  const parent = members.map((_, i) => i);
  function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(x, y) { parent[find(x)] = find(y); }

  for (const { a, b } of addressEdges) union(a, b);

  const groups = new Map();
  for (let i = 0; i < members.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const subClusters = [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      const clusterMembers = g.map((i) => members[i]);
      const bestScore = Math.max(
        ...addressEdges
          .filter(({ a, b }) => g.includes(a) && g.includes(b))
          .map((e) => e.score),
      );
      // Flag clusters larger than 4 — likely still over-merged or data quality issue
      const suspicious = clusterMembers.length > 4;
      return { members: clusterMembers, size: clusterMembers.length, bestScore, suspicious };
    });

  return { subClusters, reviewPairs };
}

function toTitleCase(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

// Within a proposed cluster, find contacts that appear to be the same person:
// same normalized full name AND same normalized street. Returns groups of 2+.
function findDuplicatesInCluster(members) {
  const groups = new Map();

  for (const m of members) {
    const normName = normalizeLastName([m.firstName, m.lastName].filter(Boolean).join(" "));
    const normStreet = normalizeStreet(m.street);
    if (!normName || !normStreet) continue;
    const key = `${normName}||${normStreet}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  return [...groups.values()].filter((g) => g.length >= 2);
}

const PORTAL_ID = "46366899";

function hubspotContactUrl(id) {
  return `https://app.hubspot.com/contacts/${PORTAL_ID}/contact/${id}`;
}

// HubSpot merge UI — opens the merge dialog with primaryId pre-selected.
// Staff picks which record to keep; the other is archived.
function hubspotMergeUrl(primaryId, secondaryId) {
  return `https://app.hubspot.com/contacts/${PORTAL_ID}/contact/${primaryId}?merge=${secondaryId}`;
}

// Top-level duplicates list in HubSpot (not filterable by our IDs, but useful reference)
const HUBSPOT_DUPLICATES_URL = `https://app.hubspot.com/duplicates/${PORTAL_ID}/contacts?currentPage=1`;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write("Fetching all contacts with last names...\n");
  const raw = await fetchAllContacts();
  process.stderr.write(`Fetched ${raw.length} contacts total.\n\n`);

  const contacts = raw.map(toMatchable);
  const noLastName = raw.length - contacts.filter((c) => normalizeLastName(c.lastName)).length;
  const alreadyProcessed = contacts.filter(
    (c) => c.existingStatus === "confirmed" || c.existingStatus === "auto_householded",
  ).length;

  const eligible = contacts.filter(
    (c) =>
      normalizeLastName(c.lastName) &&
      c.existingStatus !== "confirmed" &&
      c.existingStatus !== "auto_householded",
  );

  const clusters = clusterByLastName(eligible);

  // Analyze each cluster
  const proposed = [];     // address-confirmed sub-clusters, size 2–4
  const suspicious = [];   // address-confirmed sub-clusters, size > 4 (flag for review)
  const reviewable = [];   // pairs scoring 40–79 (ZIP/email only, no street)
  const singletons = [];   // last-name groups with only one contact

  for (const [lastName, members] of clusters) {
    if (members.length === 1) {
      singletons.push({ lastName, contact: members[0] });
      continue;
    }

    const { subClusters, reviewPairs } = analyzeCluster(members);

    for (const sub of subClusters) {
      const entry = { lastName, size: sub.size, members: sub.members, bestScore: sub.bestScore };
      if (sub.suspicious) suspicious.push(entry);
      else proposed.push(entry);
    }

    for (const pair of reviewPairs) {
      reviewable.push({ lastName, size: 2, members: [pair.a, pair.b], bestScore: pair.score, signals: pair.signals });
    }
  }

  // Sort by size desc, then score desc
  proposed.sort((a, b) => b.size - a.size || b.bestScore - a.bestScore);
  suspicious.sort((a, b) => b.size - a.size);
  reviewable.sort((a, b) => b.bestScore - a.bestScore);

  // ─── Report ───────────────────────────────────────────────────────────────

  const totalProposedContacts = proposed.reduce((s, c) => s + c.size, 0);
  const totalSuspiciousContacts = suspicious.reduce((s, c) => s + c.size, 0);

  // Unique contacts in needs-review (a contact can appear in many pairs — count it once)
  const reviewableContactIds = new Set(reviewable.flatMap((r) => r.members.map((m) => m.id)));
  // Unique last-name groups that have at least one reviewable pair
  const reviewableLastNames = new Set(reviewable.map((r) => r.lastName));

  console.log("=== HOUSEHOLD CLUSTER PRE-ANALYSIS ===\n");
  console.log(`Contacts fetched:        ${raw.length}`);
  console.log(`  No last name:          ${noLastName}`);
  console.log(`  Already processed:     ${alreadyProcessed}`);
  console.log(`  Eligible for analysis: ${eligible.length}`);
  console.log("");
  console.log(`Last-name clusters:      ${clusters.size}`);
  console.log(`  Singletons:            ${singletons.length}`);
  console.log("");
  console.log(`PROPOSED (address-confirmed, 2–4 members): ${proposed.length} households, ${totalProposedContacts} contacts`);
  console.log(`SUSPICIOUS (address-confirmed, >4 members): ${suspicious.length} clusters, ${totalSuspiciousContacts} contacts`);
  console.log(`NEEDS REVIEW (ZIP/email only, no street):  ${reviewableLastNames.size} last-name groups, ${reviewableContactIds.size} unique contacts`);

  // Pre-flight: find duplicate contacts within proposed clusters
  const mergeNeeded = [];
  for (const h of proposed) {
    const dupes = findDuplicatesInCluster(h.members);
    if (dupes.length > 0) mergeNeeded.push({ lastName: h.lastName, dupes });
  }

  if (mergeNeeded.length > 0) {
    console.log(`\n⚠️  PRE-FLIGHT: ${mergeNeeded.length} households contain likely duplicate contacts`);
    console.log(`    Merge these in HubSpot before running the write pass.`);
    console.log(`    HubSpot duplicates list: ${HUBSPOT_DUPLICATES_URL}\n`);
    for (const { lastName, dupes } of mergeNeeded) {
      console.log(`  ${toTitleCase(lastName)} Household:`);
      for (const group of dupes) {
        const [primary, ...rest] = group;
        const label = `"${[primary.firstName, primary.lastName].filter(Boolean).join(" ")}" appears ${group.length}×`;
        console.log(`    ${label}`);
        for (const secondary of rest) {
          console.log(`      Merge → ${hubspotMergeUrl(primary.id, secondary.id)}`);
        }
      }
    }
  } else {
    console.log("\n✓  PRE-FLIGHT: No duplicate contacts detected in proposed households.");
  }

  if (proposed.length > 0) {
    console.log("\n--- PROPOSED HOUSEHOLDS (sample) ---");
    for (const h of proposed.slice(0, 10)) {
      const names = h.members.map((m) => [m.firstName, m.lastName].filter(Boolean).join(" "));
      console.log(`  [${h.bestScore}] ${toTitleCase(h.lastName)} Household — ${h.size} contacts: ${names.join("  |  ")}`);
    }
    if (proposed.length > 10) console.log(`  ... and ${proposed.length - 10} more`);
  }

  if (suspicious.length > 0) {
    console.log("\n--- SUSPICIOUS (>4 members, inspect before writing) ---");
    for (const h of suspicious) {
      const names = h.members.map((m) => [m.firstName, m.lastName].filter(Boolean).join(" "));
      console.log(`  [${h.bestScore}] ${toTitleCase(h.lastName)} Household — ${h.size} contacts: ${names.slice(0, 4).join("  |  ")}${h.size > 4 ? "  ..." : ""}`);
    }
  }

  if (reviewable.length > 0) {
    console.log("\n--- NEEDS REVIEW (sample, ZIP/email signal only) ---");
    for (const h of reviewable.slice(0, 10)) {
      const names = h.members.map((m) => [m.firstName, m.lastName].filter(Boolean).join(" "));
      console.log(`  [${h.bestScore}] ${h.lastName}: ${names.join("  |  ")} (${h.signals.join(", ")})`);
    }
    if (reviewable.length > 10) console.log(`  ... and ${reviewable.length - 10} more`);
  }

  console.log("");

  // JSON output
  if (OUT_FILE) {
    const toContactShape = (m) => ({
      id: m.id,
      name: [m.firstName, m.lastName].filter(Boolean).join(" "),
      email: m.email,
      street: m.street,
      normalizedStreet: normalizeStreet(m.street),
      zip: m.zip,
      normalizedZip: normalizeZip(m.zip),
    });

    const report = {
      preflight: {
        mergeCandidates: mergeNeeded.map(({ lastName, dupes }) => ({
          lastName,
          groups: dupes.map((group) =>
            group.map((m) => ({
              id: m.id,
              name: [m.firstName, m.lastName].filter(Boolean).join(" "),
              hubspotUrl: hubspotContactUrl(m.id),
            })),
          ),
        })),
      },
      summary: {
        contactsFetched: raw.length,
        noLastName,
        alreadyProcessed,
        eligible: eligible.length,
        lastNameClusters: clusters.size,
        singletons: singletons.length,
        proposedHouseholds: proposed.length,
        proposedContacts: totalProposedContacts,
        suspiciousClusters: suspicious.length,
        suspiciousContacts: totalSuspiciousContacts,
        reviewableLastNameGroups: reviewableLastNames.size,
        reviewableUniqueContacts: reviewableContactIds.size,
      },
      proposed: proposed.map((h) => ({
        lastName: h.lastName,
        householdName: `${toTitleCase(h.lastName)} Household`,
        size: h.size,
        bestScore: h.bestScore,
        contacts: h.members.map(toContactShape),
      })),
      suspicious: suspicious.map((h) => ({
        lastName: h.lastName,
        householdName: `${toTitleCase(h.lastName)} Household`,
        size: h.size,
        bestScore: h.bestScore,
        contacts: h.members.map(toContactShape),
      })),
      needsReview: reviewable.map((h) => ({
        lastName: h.lastName,
        bestScore: h.bestScore,
        signals: h.signals,
        contacts: h.members.map(toContactShape),
      })),
    };

    writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    process.stderr.write(`Full report written to ${OUT_FILE}\n`);
  }

  if (MD_FILE) {
    const s = {
      contactsFetched: raw.length,
      alreadyProcessed,
      eligible: eligible.length,
      lastNameClusters: clusters.size,
      singletons: singletons.length,
      proposedHouseholds: proposed.length,
      proposedContacts: totalProposedContacts,
      suspiciousClusters: suspicious.length,
      suspiciousContacts: totalSuspiciousContacts,
      reviewableGroups: reviewableLastNames.size,
      reviewableContacts: reviewableContactIds.size,
    };

    const lines = [];
    const date = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    lines.push("# Household Cluster Pre-Analysis");
    lines.push("");
    lines.push(`_Run: ${date}_`);
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push("| | |");
    lines.push("|---|---|");
    lines.push(`| Contacts fetched | ${s.contactsFetched.toLocaleString()} |`);
    lines.push(`| Already processed | ${s.alreadyProcessed} |`);
    lines.push(`| Eligible for analysis | ${s.eligible.toLocaleString()} |`);
    lines.push(`| Distinct last-name clusters | ${s.lastNameClusters.toLocaleString()} |`);
    lines.push(`| Singletons | ${s.singletons.toLocaleString()} |`);
    lines.push("");
    lines.push("## Results");
    lines.push("");
    lines.push("| Decision | Count | Contacts |");
    lines.push("|---|---|---|");
    lines.push(`| **Proposed household** (address-confirmed, 2–4 members) | ${s.proposedHouseholds} | ${s.proposedContacts} |`);
    lines.push(`| **Suspicious** (address-confirmed, >4 members) | ${s.suspiciousClusters} | ${s.suspiciousContacts} |`);
    lines.push(`| **Needs review** (ZIP or email domain only, no street) | ${s.reviewableGroups} last-name groups | ${s.reviewableContacts} unique contacts |`);
    lines.push(`| **Singletons** (no matchable pair) | ${s.singletons} | ${s.singletons} |`);
    lines.push("");

    if (mergeNeeded.length > 0) {
      lines.push("---");
      lines.push("");
      lines.push(`## ⚠️ Pre-flight: ${mergeNeeded.length} Households With Duplicate Contacts`);
      lines.push("");
      lines.push(`> Merge these in HubSpot before running the write pass. [Open HubSpot duplicates list](${HUBSPOT_DUPLICATES_URL})`);
      lines.push("");
      for (const { lastName, dupes } of mergeNeeded) {
        lines.push(`### ${toTitleCase(lastName)} Household`);
        lines.push("");
        for (const group of dupes) {
          const [primary, ...rest] = group;
          const name = [primary.firstName, primary.lastName].filter(Boolean).join(" ");
          lines.push(`**"${name}" appears ${group.length}×** — keep the oldest record, merge the rest:`);
          lines.push("");
          for (const secondary of rest) {
            lines.push(`- [Merge into primary](${hubspotMergeUrl(primary.id, secondary.id)})`);
          }
          lines.push("");
        }
      }
    }

    lines.push("---");
    lines.push("");
    lines.push(`## Proposed Households (${proposed.length} total)`);
    lines.push("");
    lines.push("> All confirmed by shared street address. Size ≤ 4. _Member counts include duplicates — merge first._");
    lines.push("");
    lines.push("| Household | Members | Score |");
    lines.push("|---|---|---|");
    for (const h of proposed) {
      const hasDupes = mergeNeeded.some((m) => m.lastName === h.lastName);
      const flag = hasDupes ? " ⚠️" : "";
      const names = h.members.map((m) => m.firstName && m.lastName
        ? `${m.firstName} ${m.lastName}` : m.lastName ?? "").join(", ");
      lines.push(`| ${toTitleCase(h.lastName)} Household${flag} | ${h.size} — ${names} | ${h.bestScore} |`);
    }
    lines.push("");
    lines.push("_⚠️ = contains duplicate contacts, merge before write pass_");
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## Needs Review (${s.reviewableGroups} last-name groups, ${s.reviewableContacts} unique contacts)`);
    lines.push("");
    lines.push("> Share a last name + ZIP or email domain but no street address match. Most are unrelated people with the same surname. Defer until after go-live when transaction data provides stronger signal.");
    lines.push("");

    writeFileSync(MD_FILE, lines.join("\n") + "\n");
    process.stderr.write(`Markdown report written to ${MD_FILE}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
