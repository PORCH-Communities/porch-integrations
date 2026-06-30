import type { GivebutterDonation } from "../givebutter/payloads.ts";
import {
  findBestHouseholdMatch,
  normalizeLastName,
  type HouseholdCandidate,
  type HouseholdMatchResult,
} from "../householding/matching.ts";
import type { HubSpotClient, HubSpotCompany } from "./client.ts";

const TERMINAL_HOUSEHOLD_STATUSES = new Set([
  "confirmed",
  "auto_householded",
  "no_match",
]);

const HOUSEHOLD_COMPANY_PROPERTIES = [
  "name",
  "record_type",
  "address",
  "zip",
  "email",
];

type HouseholdMatchingClient = Pick<
  HubSpotClient,
  | "searchCompanies"
  | "updateContactProperties"
  | "associateContactToCompany"
  | "associateDealToCompany"
>;

export type HouseholdMatchingMode = "shadow" | "write";

export type HouseholdProcessingResult =
  | {
      status: "matched";
      mode: HouseholdMatchingMode;
      match: HouseholdMatchResult;
      candidateCount: number;
    }
  | {
      status: "skipped";
      mode: HouseholdMatchingMode;
      reason: string;
      existingStatus?: string | null;
    };

export async function processDonationHouseholdMatch(
  client: HouseholdMatchingClient,
  input: {
    donation: GivebutterDonation;
    contactId: string | null;
    dealId: string | null;
    existingStatus?: string | null;
    mode: HouseholdMatchingMode;
  },
): Promise<HouseholdProcessingResult> {
  const { donation, contactId, dealId, existingStatus, mode } = input;

  if (donation.donorType === "organization") {
    return {
      status: "skipped",
      mode,
      reason: "Organization donors are excluded from household matching.",
    };
  }

  if (existingStatus && TERMINAL_HOUSEHOLD_STATUSES.has(existingStatus)) {
    return {
      status: "skipped",
      mode,
      existingStatus,
      reason: `Contact household status is already terminal: ${existingStatus}.`,
    };
  }

  const candidates = await findHouseholdCompanies(client, donation);
  const match = findBestHouseholdMatch(
    {
      firstName: donation.firstName,
      lastName: donation.lastName,
      email: donation.email,
      street: donation.address.line1,
      zip: donation.address.postalCode,
    },
    candidates,
  );

  if (mode === "write") {
    if (!contactId || !dealId) {
      throw new Error("Cannot apply a household match without HubSpot contact and deal IDs.");
    }

    await applyHouseholdDecision(client, contactId, dealId, match);
  }

  return { status: "matched", mode, match, candidateCount: candidates.length };
}

export async function findHouseholdCompanies(
  client: Pick<HubSpotClient, "searchCompanies">,
  donation: GivebutterDonation,
): Promise<HouseholdCandidate[]> {
  const lastName = donation.lastName?.trim() ?? "";
  const street = donation.address.line1?.trim() ?? "";
  const searches: Array<Promise<HubSpotCompany[]>> = [];

  if (lastName) {
    searches.push(
      client.searchCompanies(
        "name",
        `${lastName} Household`,
        HOUSEHOLD_COMPANY_PROPERTIES,
      ),
    );
  }

  if (street) {
    searches.push(
      client.searchCompanies("address", street, HOUSEHOLD_COMPANY_PROPERTIES),
    );
  }

  const companies = (await Promise.all(searches)).flat();
  const uniqueCompanies = new Map(companies.map((company) => [company.id, company]));

  return [...uniqueCompanies.values()]
    .filter((company) => company.properties.record_type === "household")
    .map(toHouseholdCandidate);
}

async function applyHouseholdDecision(
  client: HouseholdMatchingClient,
  contactId: string,
  dealId: string,
  match: HouseholdMatchResult,
): Promise<void> {
  const suggestion = match.candidate
    ? `${match.candidate.hubspotCompanyId} | ${match.candidate.householdName}`
    : "";

  if (match.decision === "auto_household" && match.candidate) {
    const companyId = match.candidate.hubspotCompanyId;

    await client.updateContactProperties(contactId, {
      household_match_status: "auto_householded",
      suggested_household_match: suggestion,
      household_match_score: String(match.score),
    });
    await Promise.all([
      client.associateContactToCompany(contactId, companyId),
      client.associateDealToCompany(dealId, companyId),
    ]);
    return;
  }

  if (match.decision === "needs_review") {
    await client.updateContactProperties(contactId, {
      household_match_status: "needs_review",
      suggested_household_match: suggestion,
      household_match_score: String(match.score),
    });
    return;
  }

  await client.updateContactProperties(contactId, {
    household_match_status: "no_match",
    suggested_household_match: "",
    household_match_score: "",
  });
}

function toHouseholdCandidate(company: HubSpotCompany): HouseholdCandidate {
  const householdName = company.properties.name?.trim() || `Household ${company.id}`;

  return {
    hubspotCompanyId: company.id,
    householdName,
    lastName: extractHouseholdLastName(householdName),
    street: company.properties.address,
    zip: company.properties.zip,
    email: company.properties.email,
  };
}

function extractHouseholdLastName(name: string): string {
  const withoutSuffix = name.replace(/\s+household$/i, "").trim();

  return normalizeLastName(withoutSuffix);
}
