import type { HubSpotClient } from "./client";

const INDIVIDUAL_DONATIONS_PIPELINE_ID = "155504019";

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

export async function confirmContactHousehold(
  client: HubSpotClient,
  contactId: string,
): Promise<HouseholdConfirmationResult> {
  const contact = await client.getContact(contactId);

  if (contact.properties.household_match_status !== "confirmed") {
    return {
      status: "ignored_not_confirmed",
      contactId,
      reason: "Contact is no longer confirmed.",
    };
  }

  const companyId = parseSuggestedHouseholdCompanyId(
    contact.properties.suggested_household_match,
  );

  if (!companyId) {
    return {
      status: "needs_attention",
      contactId,
      reason: "Confirmed contact has no suggested household company ID.",
    };
  }

  const company = await client.getCompany(companyId);

  if (company.properties.record_type !== "household") {
    return {
      status: "needs_attention",
      contactId,
      reason: "Suggested company is not marked as a Household.",
    };
  }

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

export function parseSuggestedHouseholdCompanyId(value?: string | null): string | null {
  return value?.trim().match(/^(\d+)\b/)?.[1] ?? null;
}
