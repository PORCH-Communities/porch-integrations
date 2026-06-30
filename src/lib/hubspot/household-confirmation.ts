import type { HubSpotClient } from "./client";

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

export type HouseholdReviewAction =
  | "match_existing_household"
  | "save_new_household"
  | "no_household"
  | "confirm_household"
  | "delete_household";

export async function processHouseholdReviewAction(
  client: HubSpotClient,
  contactId: string,
  action: HouseholdReviewAction,
  companyId?: string,
): Promise<HouseholdStatusResult> {
  const contact = await client.getContact(contactId);

  if (action === "delete_household") {
    if (!companyId) {
      return { status: "needs_attention", contactId, reason: "delete_household requires a companyId." };
    }
    const company = await client.getCompany(companyId);
    if (company.properties.record_type !== "household") {
      return { status: "needs_attention", contactId, reason: "Specified company is not a Household." };
    }
    const members = await client.getCompanyContactAssociations(companyId);
    if (members.length > 0) {
      return { status: "needs_attention", contactId, reason: "Cannot delete a Household that still has members." };
    }
    await client.archiveCompany(companyId);
    return { status: "review_fields_cleared", contactId, reason: `Household ${companyId} deleted.` };
  }

  if (action === "confirm_household") {
    if (!companyId) {
      return { status: "needs_attention", contactId, reason: "confirm_household requires a companyId." };
    }
    const company = await client.getCompany(companyId);
    if (company.properties.record_type !== "household") {
      return { status: "needs_attention", contactId, reason: "Specified company is not a Household." };
    }
    // Disassociate from all other household companies, keep the chosen one.
    const allCompanyIds = uniqueIds(contact.associations?.companies?.results);
    const otherHouseholds = await Promise.all(
      allCompanyIds.filter((id) => id !== companyId).map((id) => client.getCompany(id)),
    );
    for (const other of otherHouseholds) {
      if (other.properties.record_type === "household") {
        await client.disassociateContactFromCompany(contactId, other.id);
      }
    }
    await client.associateContactToCompany(contactId, companyId);
    await client.updateContactProperties(contactId, {
      household_match_status: "confirmed",
      suggested_household_match: `${companyId} | ${company.properties.name ?? ""}`,
      household_match_score: "",
    });
    return confirmContactHousehold(client, contactId);
  }

  if (contact.properties.household_match_status !== "needs_review") {
    return {
      status: "ignored_not_actionable",
      contactId,
      reason: "Contact is no longer awaiting household review.",
    };
  }

  if (action === "no_household") {
    await client.updateContactProperties(contactId, {
      household_match_status: "no_match",
      suggested_household_match: "",
      household_match_score: "",
    });
    return { status: "review_fields_cleared", contactId };
  }

  if (action === "save_new_household") {
    const lastName = contact.properties.lastname?.trim();
    if (!lastName) {
      return { status: "needs_attention", contactId, reason: "Contact has no last name." };
    }

    const companyProperties = compactProperties({
      name: `${lastName} Household`,
      envelope_name: `The ${lastName} Family`,
      record_type: "household",
      address: contact.properties.address,
      city: contact.properties.city,
      state: contact.properties.state,
      zip: contact.properties.zip,
    });
    const company = await client.createCompany(companyProperties);
    await client.associateContactToCompany(contactId, company.id);
    await client.updateContactProperties(contactId, {
      household_match_status: "confirmed",
      suggested_household_match: `${company.id} | ${companyProperties.name}`,
    });
    return confirmContactHousehold(client, contactId);
  }

  const suggestedCompanyId = parseSuggestedHouseholdCompanyId(
    contact.properties.suggested_household_match,
  );
  if (!suggestedCompanyId) {
    return { status: "needs_attention", contactId, reason: "No suggested Household is selected." };
  }
  const suggestedCompany = await client.getCompany(suggestedCompanyId);
  if (suggestedCompany.properties.record_type !== "household") {
    return { status: "needs_attention", contactId, reason: "Suggested company is not a Household." };
  }

  await client.updateContactProperties(contactId, { household_match_status: "confirmed" });
  return confirmContactHousehold(client, contactId);
}

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
  const contactDeals = await client.getDeals(contactDealIds, [
    "pipeline",
    "givebutter_transaction_id",
    "givebutter_reference_number",
  ]);
  // Associate any deal Vercel has touched (across all three in-scope pipelines),
  // identified by the presence of a Givebutter idempotency key.
  const donationDealIds = contactDeals
    .filter(
      (deal) =>
        deal.properties.givebutter_transaction_id?.trim() ||
        deal.properties.givebutter_reference_number?.trim(),
    )
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

  const hasGivebutterKey =
    deal.properties.givebutter_transaction_id?.trim() ||
    deal.properties.givebutter_reference_number?.trim();

  if (!hasGivebutterKey) {
    return {
      status: "ignored",
      dealId,
      reason: "Deal has no Givebutter identifier (not a Vercel-created donation deal).",
    };
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

function compactProperties(
  properties: Record<string, string | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );
}
