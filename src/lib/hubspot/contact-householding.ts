import {
  findBestHouseholdMatch,
  normalizeLastName,
  type HouseholdCandidate,
} from "../householding/matching.ts";
import type { HubSpotClient, HubSpotCompany } from "./client.ts";

const HOUSEHOLD_PROPERTIES = ["name", "record_type", "address", "zip", "email"];
const TERMINAL_STATUSES = new Set(["confirmed", "auto_householded"]);

export type EnsureContactHouseholdResult =
  | { status: "created" | "matched" | "already_householded"; contactId: string; companyId: string }
  | { status: "needs_review"; contactId: string; reason: string };

export async function ensureContactHousehold(
  client: HubSpotClient,
  contactId: string,
): Promise<EnsureContactHouseholdResult> {
  const contact = await client.getContact(contactId);
  const associatedCompanies = await Promise.all(
    uniqueIds(contact.associations?.companies?.results).map((id) => client.getCompany(id)),
  );
  const associatedHouseholds = associatedCompanies.filter(
    (company) => company.properties.record_type === "household",
  );

  if (associatedHouseholds.length === 1) {
    const company = associatedHouseholds[0];
    if (!TERMINAL_STATUSES.has(contact.properties.household_match_status ?? "")) {
      await client.updateContactProperties(contactId, {
        household_match_status: "confirmed",
        suggested_household_match: `${company.id} | ${company.properties.name ?? "Household"}`,
        household_match_score: "",
      });
    }
    return { status: "already_householded", contactId, companyId: company.id };
  }

  if (associatedHouseholds.length > 1) {
    await markNeedsReview(client, contactId, "", "");
    return { status: "needs_review", contactId, reason: "Contact has multiple Household associations." };
  }

  const lastName = contact.properties.lastname?.trim();
  if (!normalizeLastName(lastName)) {
    await markNeedsReview(client, contactId, "", "0");
    return { status: "needs_review", contactId, reason: "Contact has no last name." };
  }

  const street = contact.properties.address?.trim() ?? "";
  const searches: Array<Promise<HubSpotCompany[]>> = [
    client.searchCompanies("name", `${lastName} Household`, HOUSEHOLD_PROPERTIES),
  ];
  if (street) searches.push(client.searchCompanies("address", street, HOUSEHOLD_PROPERTIES));

  const candidates = toCandidates((await Promise.all(searches)).flat());
  const match = findBestHouseholdMatch(
    {
      firstName: contact.properties.firstname,
      lastName,
      email: contact.properties.email,
      street,
      zip: contact.properties.zip,
    },
    candidates,
  );

  if (match.decision === "auto_household" && match.candidate) {
    const companyId = match.candidate.hubspotCompanyId;
    await client.associateContactToCompany(contactId, companyId);
    await client.updateContactProperties(contactId, {
      household_match_status: "auto_householded",
      suggested_household_match: `${companyId} | ${match.candidate.householdName}`,
      household_match_score: String(match.score),
    });
    return { status: "matched", contactId, companyId };
  }

  if (match.decision === "needs_review") {
    const suggestion = match.candidate
      ? `${match.candidate.hubspotCompanyId} | ${match.candidate.householdName}`
      : "";
    await markNeedsReview(client, contactId, suggestion, String(match.score));
    return { status: "needs_review", contactId, reason: "Possible Household match requires review." };
  }

  // Re-check by canonical name immediately before creation. This makes webhook retries
  // safe and narrows the race window when two related contacts are created together.
  const existing = await client.searchCompanies(
    "name",
    `${lastName} Household`,
    HOUSEHOLD_PROPERTIES,
  );
  if (existing.some((company) => company.properties.record_type === "household")) {
    await markNeedsReview(client, contactId, "", "40");
    return { status: "needs_review", contactId, reason: "A same-name Household appeared during creation." };
  }

  const properties = compact({
    name: `${lastName} Household`,
    envelope_name: `The ${lastName} Family`,
    record_type: "household",
    address: contact.properties.address,
    city: contact.properties.city,
    state: contact.properties.state,
    zip: contact.properties.zip,
  });
  const company = await client.createCompany(properties);
  await client.associateContactToCompany(contactId, company.id);
  await client.updateContactProperties(contactId, {
    household_match_status: "auto_householded",
    suggested_household_match: `${company.id} | ${properties.name}`,
    household_match_score: "100",
  });
  return { status: "created", contactId, companyId: company.id };
}

async function markNeedsReview(
  client: HubSpotClient,
  contactId: string,
  suggestion: string,
  score: string,
) {
  await client.updateContactProperties(contactId, {
    household_match_status: "needs_review",
    suggested_household_match: suggestion,
    household_match_score: score,
  });
}

function toCandidates(companies: HubSpotCompany[]): HouseholdCandidate[] {
  return [...new Map(companies.map((company) => [company.id, company])).values()]
    .filter((company) => company.properties.record_type === "household")
    .map((company) => {
      const householdName = company.properties.name?.trim() || `Household ${company.id}`;
      return {
        hubspotCompanyId: company.id,
        householdName,
        lastName: householdName.replace(/\s+household$/i, ""),
        street: company.properties.address,
        zip: company.properties.zip,
        email: company.properties.email,
      };
    });
}

function uniqueIds(results?: Array<{ id: string }>): string[] {
  return [...new Set(results?.map(({ id }) => id) ?? [])];
}

function compact(values: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}
