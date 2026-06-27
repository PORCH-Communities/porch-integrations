import type { HubSpotClient } from "./client";

const INDIVIDUAL_DONATIONS_PIPELINE_ID = "155504019";

type HouseholdResolution =
  | { ok: true; companyId: string }
  | { ok: false; reason: string };

export type HouseholdConfirmationResult =
  | {
      status: "associated";
      contactId: string;
      companyId: string;
      associatedDealIds: string[];
    }
  | {
      status: "ignored_not_confirmed" | "needs_attention";
      contactId: string;
      reason: string;
    };

export type HouseholdStatusResult =
  | HouseholdConfirmationResult
  | {
      status: "review_fields_cleared" | "ignored_not_actionable";
      contactId: string;
      reason?: string;
    };

export type DonationHouseholdResult =
  | {
      status: "associated" | "already_associated";
      dealId: string;
      companyId: string;
    }
  | {
      status: "ignored" | "needs_attention";
      dealId: string;
      reason: string;
    };

export async function processHouseholdStatusChange(
  client: HubSpotClient,
  contactId: string,
): Promise<HouseholdStatusResult> {
  const contact = await client.getContact(contactId);
  const status = contact.properties.household_match_status;

  if (status === "confirmed") {
    return confirmLoadedContactHousehold(client, contact);
  }

  if (status === "no_match") {
    await client.updateContactProperties(contactId, {
      suggested_household_match: "",
      household_match_score: "",
    });

    return { status: "review_fields_cleared", contactId };
  }

  return {
    status: "ignored_not_actionable",
    contactId,
    reason: `No automated side effect for household status: ${status ?? "empty"}.`,
  };
}

export async function confirmContactHousehold(
  client: HubSpotClient,
  contactId: string,
): Promise<HouseholdConfirmationResult> {
  const contact = await client.getContact(contactId);

  return confirmLoadedContactHousehold(client, contact);
}

async function confirmLoadedContactHousehold(
  client: HubSpotClient,
  contact: Awaited<ReturnType<HubSpotClient["getContact"]>>,
): Promise<HouseholdConfirmationResult> {
  const contactId = contact.id;

  if (contact.properties.household_match_status !== "confirmed") {
    return {
      status: "ignored_not_confirmed",
      contactId,
      reason: "Contact is no longer confirmed.",
    };
  }

  const resolution = await resolveContactHousehold(client, contact);

  if (!resolution.ok) {
    return {
      status: "needs_attention",
      contactId,
      reason: resolution.reason,
    };
  }

  const companyId = resolution.companyId;

  await client.associateContactToCompany(contactId, companyId);

  const contactDealIds = contact.associations?.deals?.results?.map(({ id }) => id) ?? [];
  const contactDeals = await client.getDeals(contactDealIds);
  const donationDealIds = contactDeals
    .filter((deal) => deal.properties.pipeline === INDIVIDUAL_DONATIONS_PIPELINE_ID)
    .map((deal) => deal.id);

  await Promise.all(
    donationDealIds.map((dealId) => client.associateDealToCompany(dealId, companyId)),
  );

  return {
    status: "associated",
    contactId,
    companyId,
    associatedDealIds: donationDealIds,
  };
}

export async function associateGivebutterDealToHousehold(
  client: HubSpotClient,
  dealId: string,
): Promise<DonationHouseholdResult> {
  const deal = await client.getDeal(dealId);

  if (deal.properties.pipeline !== INDIVIDUAL_DONATIONS_PIPELINE_ID) {
    return {
      status: "ignored",
      dealId,
      reason: "Deal is not in the Individual Donations pipeline.",
    };
  }

  if (!deal.properties.givebutter_reference_number?.trim()) {
    return { status: "ignored", dealId, reason: "Deal has no Givebutter reference number." };
  }

  const contactIds = uniqueIds(deal.associations?.contacts?.results);

  if (contactIds.length === 0) {
    return { status: "ignored", dealId, reason: "Deal has no associated contacts." };
  }

  const householdIds = new Set<string>();

  for (const contactId of contactIds) {
    const contact = await client.getContact(contactId);
    const status = contact.properties.household_match_status;

    if (status !== "confirmed" && status !== "auto_householded") {
      continue;
    }

    const resolution = await resolveContactHousehold(client, contact);

    if (!resolution.ok) {
      return { status: "needs_attention", dealId, reason: resolution.reason };
    }

    householdIds.add(resolution.companyId);
  }

  if (householdIds.size === 0) {
    return {
      status: "ignored",
      dealId,
      reason: "No associated contact has a confirmed household.",
    };
  }

  if (householdIds.size > 1) {
    return {
      status: "needs_attention",
      dealId,
      reason: "Deal contacts resolve to multiple Household companies.",
    };
  }

  const companyId = [...householdIds][0];
  const existingCompanyIds = new Set(uniqueIds(deal.associations?.companies?.results));

  if (existingCompanyIds.has(companyId)) {
    return { status: "already_associated", dealId, companyId };
  }

  await client.associateDealToCompany(dealId, companyId);

  return { status: "associated", dealId, companyId };
}

async function resolveContactHousehold(
  client: HubSpotClient,
  contact: Awaited<ReturnType<HubSpotClient["getContact"]>>,
): Promise<HouseholdResolution> {
  const associatedCompanyIds = uniqueIds(contact.associations?.companies?.results);
  const associatedCompanies = await Promise.all(
    associatedCompanyIds.map((companyId) => client.getCompany(companyId)),
  );
  const householdCompanies = associatedCompanies.filter(
    (company) => company.properties.record_type === "household",
  );

  if (householdCompanies.length > 1) {
    return { ok: false, reason: "Contact is associated with multiple Household companies." };
  }

  if (householdCompanies.length === 1) {
    return { ok: true, companyId: householdCompanies[0].id };
  }

  const suggestedCompanyId = parseSuggestedHouseholdCompanyId(
    contact.properties.suggested_household_match,
  );

  if (!suggestedCompanyId) {
    return {
      ok: false,
      reason: "Confirmed contact has no associated or suggested Household company.",
    };
  }

  const suggestedCompany = await client.getCompany(suggestedCompanyId);

  if (suggestedCompany.properties.record_type !== "household") {
    return { ok: false, reason: "Suggested company is not marked as a Household." };
  }

  return { ok: true, companyId: suggestedCompanyId };
}

function uniqueIds(results?: Array<{ id: string }>): string[] {
  return [...new Set(results?.map(({ id }) => id) ?? [])];
}

export function parseSuggestedHouseholdCompanyId(value?: string | null): string | null {
  return value?.trim().match(/^(\d+)\b/)?.[1] ?? null;
}
