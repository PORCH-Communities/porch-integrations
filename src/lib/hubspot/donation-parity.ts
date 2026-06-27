import type { GivebutterDonation } from "../givebutter/payloads.ts";
import type {
  HubSpotClient,
  HubSpotCompany,
  HubSpotContact,
  HubSpotDeal,
} from "./client";
import {
  DEAL_MATCH_PIPELINES,
  findDealCandidates,
  findBestDealMatch,
  type DealMatchResult,
} from "./deal-matching.ts";

export const INDIVIDUAL_DONATIONS_PIPELINE_ID = "155504019";
export const DONATION_COMPLETE_STAGE_ID = "261678424";
export const PORCH_DONATION_OWNER_ID = "807444275";
export const CHAPTER_FINANCIAL_DONOR_ASSOCIATION_TYPE_ID = 11;
export const COMPANY_DONATION_CONTACT_ASSOCIATION_TYPE_ID = 3;
export const CHAPTER_DONATION_CONTACT_ASSOCIATION_TYPE_ID = 12;

export type DonationParityMode = "shadow" | "write";

type DonationParityClient = Pick<
  HubSpotClient,
  | "searchContacts"
  | "searchCompanies"
  | "searchDeals"
  | "getDeals"
  | "getCompany"
  | "createContact"
  | "createCompany"
  | "createDeal"
  | "updateContact"
  | "updateDeal"
  | "associateContactToDeal"
  | "associateContactToDealWithType"
  | "associateContactToCompany"
  | "associateDealToCompany"
  | "getCompanyContactAssociations"
  | "getDealContactAssociations"
  | "getDealCompanyAssociations"
>;

type ObjectOutcome = {
  action: "create" | "update" | "use_existing" | "would_create" | "would_update";
  id: string | null;
};

export type DonationParityResult = {
  status: "processed" | "shadowed" | "needs_attention";
  mode: DonationParityMode;
  transactionId: string | null;
  referenceNumber: string | null;
  contact?: ObjectOutcome;
  deal?: ObjectOutcome;
  destination?: "Chapter" | "PORCH-Communities";
  chapterCompanyId?: string | null;
  donorCompany?: ObjectOutcome | null;
  dealMatchResult?: DealMatchResult | null;
  actions: string[];
  warnings: string[];
  reason?: string;
};

export function getDonationParityMode(
  value = process.env.GIVEBUTTER_HUBSPOT_MODE,
): DonationParityMode {
  return value?.trim().toLowerCase() === "write" ? "write" : "shadow";
}

export async function processGivebutterDonation(
  client: DonationParityClient,
  donation: GivebutterDonation,
  mode: DonationParityMode,
): Promise<DonationParityResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const transactionId = asString(donation.transactionId);
  const referenceNumber = asString(donation.transactionNumber);
  const contactId = asString(donation.contactId);
  const email = donation.email?.trim() || null;

  if (!transactionId && !referenceNumber) {
    return needsAttention(mode, donation, "Donation has no Givebutter transaction identifier.");
  }

  if (!contactId && !email) {
    return needsAttention(mode, donation, "Donation has neither an email nor a Givebutter Contact ID.");
  }

  const existingContact = await findExistingContact(client, donation, email, warnings);
  const contactProperties = buildContactProperties(donation);
  const contact = await upsertContact(client, existingContact, contactProperties, mode, actions);

  const chapterCompany = await findFirstCompany(
    client,
    "givebutter_code",
    donation.campaignCode,
    warnings,
    "chapter company",
  );
  const destination = chapterCompany ? "Chapter" : "PORCH-Communities";

  if (!donation.campaignCode) {
    warnings.push("Donation has no campaign code; routed to PORCH Communities.");
  }

  const resolvedContactId = contact.id ?? contactId;
  const { deal: existingDeal, matchResult: dealMatchResult } = await findExistingDeal(
    client,
    donation,
    resolvedContactId,
    warnings,
  );
  const dealProperties = buildDealProperties(donation, destination, dealMatchResult);
  const deal = await upsertDeal(client, existingDeal, dealMatchResult, dealProperties, mode, actions, warnings);

  if (mode === "write") {
    if (!contact.id || !deal.id) {
      throw new Error("Write mode did not produce HubSpot contact and deal IDs.");
    }

    await client.associateContactToDeal(contact.id, deal.id);
    actions.push("associate_contact_to_deal");

    if (chapterCompany) {
      await associateChapterPath(client, contact.id, deal.id, chapterCompany, actions, warnings);
    }
  } else {
    actions.push("would_associate_contact_to_deal");

    if (chapterCompany) {
      actions.push(
        "would_associate_deal_to_chapter",
        "would_add_chapter_financial_donor_association",
      );
      const chapterLeadId = await findChapterLeadContactId(client, chapterCompany.id, warnings);

      if (chapterLeadId) {
        actions.push("would_add_chapter_donation_contact_association");
      }
    }
  }

  const donorCompany = await processDonorCompany(
    client,
    donation.companyName,
    contact.id,
    deal.id,
    mode,
    actions,
    warnings,
  );

  return {
    status: mode === "write" ? "processed" : "shadowed",
    mode,
    transactionId,
    referenceNumber,
    contact,
    deal,
    destination,
    chapterCompanyId: chapterCompany?.id ?? null,
    donorCompany,
    dealMatchResult: dealMatchResult ?? null,
    actions,
    warnings,
  };
}

export function buildContactProperties(
  donation: GivebutterDonation,
): Record<string, string> {
  return compactProperties({
    email: donation.email,
    address: donation.address.line1,
    city: donation.address.city,
    state: donation.address.state,
    zip: donation.address.postalCode,
    country: donation.address.country,
    firstname: donation.firstName,
    lastname: donation.lastName,
    company: donation.companyName,
    givebutter_contact_id: asString(donation.contactId),
    mobilephone: donation.phone,
    phone: donation.phone,
    hs_latest_source: "DIRECT_TRAFFIC",
    hubspot_owner_id: PORCH_DONATION_OWNER_ID,
  });
}

export function buildDealProperties(
  donation: GivebutterDonation,
  destination: "Chapter" | "PORCH-Communities",
  matchResult?: DealMatchResult | null,
): Record<string, string> {
  const eventDate = donation.createdAt ?? donation.transactedAt;
  const donorName = [donation.firstName, donation.lastName].filter(Boolean).join(" ").trim();
  const amount = donation.amount === null ? null : String(donation.amount);
  const dealName = [`$${amount ?? ""}`, donorName].filter(Boolean).join(" ").trim();
  const campaign =
    donation.campaignTitle && donation.campaignCode
      ? `${donation.campaignTitle}-${donation.campaignCode}`
      : (donation.campaignTitle ?? donation.campaignCode ?? "");
  const donorAddress = [
    donation.address.line1,
    donation.address.city,
    [donation.address.state, donation.address.postalCode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  const referenceNumber = asString(donation.transactionNumber);

  // For new (unmatched) deals: set deal_match_status based on matchResult.
  // For auto-closed matched deals: the status is set in upsertDeal to "auto_closed".
  // For needs_review: the holding deal carries status + candidate pointer.
  let dealMatchStatus: string | null = null;
  let candidateDealId: string | null = null;

  if (!matchResult) {
    dealMatchStatus = "unprocessed";
  } else if (matchResult.decision === "needs_review") {
    dealMatchStatus = "needs_review";
    candidateDealId = matchResult.candidate?.id ?? null;
  }

  return compactProperties({
    dealname: dealName || `Givebutter Donation ${referenceNumber ?? ""}`.trim(),
    pipeline: INDIVIDUAL_DONATIONS_PIPELINE_ID,
    dealstage: DONATION_COMPLETE_STAGE_ID,
    amount,
    chapter_city: donation.address.city,
    chapter_state: donation.address.state,
    closedate: eventDate,
    createdate: eventDate,
    dedication_name: donation.dedication.name,
    dedication_recipient_email: donation.dedication.recipientEmail,
    dedication_recipient_name: donation.dedication.recipientName,
    dedication_type: donation.dedication.type,
    description: referenceNumber,
    donor_address: donorAddress,
    givebutter_campaign: campaign,
    givebutter_company_name: donation.companyName,
    givebutter_message: donation.message,
    givebutter_reference_number: isNumericIdentifier(referenceNumber) ? referenceNumber : null,
    givebutter_transaction_id: asString(donation.transactionId),
    hubspot_owner_id: PORCH_DONATION_OWNER_ID,
    destination,
    deal_match_status: dealMatchStatus,
    deal_match_score: matchResult ? String(matchResult.score) : null,
    deal_match_signals: matchResult?.signals.join(",") ?? null,
    candidate_deal_id: candidateDealId,
    referrer: donation.utm.referrer,
    utm_campaign: donation.utm.campaign,
    utm_content: donation.utm.content,
    utm_medium: donation.utm.medium,
    utm_source: donation.utm.source,
    utm_term: donation.utm.term,
  });
}

async function findExistingContact(
  client: DonationParityClient,
  donation: GivebutterDonation,
  email: string | null,
  warnings: string[],
): Promise<HubSpotContact | null> {
  const contactId = asString(donation.contactId);

  if (contactId) {
    const byGivebutterId = await client.searchContacts("givebutter_contact_id", contactId, [
      "email",
      "givebutter_contact_id",
    ]);
    const match = firstResult(byGivebutterId, warnings, "Givebutter Contact ID");

    if (match) {
      return match;
    }
  }

  if (!email) {
    return null;
  }

  const byEmail = await client.searchContacts("email", email, ["email", "givebutter_contact_id"]);

  return firstResult(byEmail, warnings, "email");
}

type ExistingDealLookup = {
  deal: HubSpotDeal | null;
  matchResult: DealMatchResult | null;
};

async function findExistingDeal(
  client: DonationParityClient,
  donation: GivebutterDonation,
  contactId: string | null,
  warnings: string[],
): Promise<ExistingDealLookup> {
  const transactionId = asString(donation.transactionId);
  const referenceNumber = asString(donation.transactionNumber);
  const dealProperties = ["givebutter_transaction_id", "givebutter_reference_number", "pipeline", "dealstage", "amount"];

  // Tier 1: idempotency key — exact Givebutter transaction ID.
  if (transactionId) {
    const byTransactionId = await client.searchDeals(
      "givebutter_transaction_id",
      transactionId,
      dealProperties,
    );
    const match = firstResult(byTransactionId, warnings, "Givebutter Transaction ID");

    if (match) {
      return { deal: match, matchResult: null };
    }
  }

  // Tier 2: reference number fallback — but only within in-scope pipelines to avoid
  // matching a staff-reclassified deal that Zapier previously stamped with a reference number.
  if (isNumericIdentifier(referenceNumber)) {
    const byReference = await client.searchDeals(
      "givebutter_reference_number",
      referenceNumber,
      dealProperties,
    );
    const match = firstResult(byReference, warnings, "Givebutter Reference Number");

    if (match) {
      if (match.properties.pipeline && match.properties.pipeline in DEAL_MATCH_PIPELINES) {
        return { deal: match, matchResult: null };
      }

      warnings.push(
        `Existing deal ${match.id} (ref ${referenceNumber}) is in pipeline ${match.properties.pipeline}, which is not managed by this integration. Skipping to avoid overwriting a staff-managed deal.`,
      );
    }
  }

  // Tier 3: pre-created deal matching by amount + contact + company.
  const candidates = await findDealCandidates(client, contactId, donation);
  const matchResult = findBestDealMatch(donation, candidates);

  if (matchResult.decision === "auto_close" && matchResult.candidate) {
    const deal = await client.searchDeals(
      "hs_object_id",
      matchResult.candidate.id,
      dealProperties,
    ).then((results) => results[0] ?? null);

    return { deal, matchResult };
  }

  return { deal: null, matchResult: matchResult.decision !== "no_match" ? matchResult : null };
}

async function upsertContact(
  client: DonationParityClient,
  existing: HubSpotContact | null,
  properties: Record<string, string>,
  mode: DonationParityMode,
  actions: string[],
): Promise<ObjectOutcome> {
  if (mode === "shadow") {
    const action = existing ? "would_update" : "would_create";
    actions.push(`${action}_contact`);
    return { action, id: existing?.id ?? null };
  }

  if (existing) {
    const updated = await client.updateContact(existing.id, properties);
    actions.push("update_contact");
    return { action: "update", id: updated.id };
  }

  const created = await client.createContact(properties);
  actions.push("create_contact");
  return { action: "create", id: created.id };
}

async function upsertDeal(
  client: DonationParityClient,
  existing: HubSpotDeal | null,
  matchResult: DealMatchResult | null,
  properties: Record<string, string>,
  mode: DonationParityMode,
  actions: string[],
  warnings: string[],
): Promise<ObjectOutcome> {
  if (mode === "shadow") {
    const action = existing ? "would_update" : "would_create";
    actions.push(`${action}_deal`);

    if (matchResult?.decision === "auto_close") {
      actions.push("would_close_matched_deal_in_place");
    } else if (matchResult?.decision === "needs_review") {
      actions.push("would_create_needs_review_holding_deal");
    }

    return { action, id: existing?.id ?? null };
  }

  if (existing) {
    // Deal was found via the match engine (not an idempotency key hit): apply pipeline-aware update.
    if (matchResult !== null) {
      const existingPipeline = existing.properties.pipeline;

      if (!existingPipeline || !(existingPipeline in DEAL_MATCH_PIPELINES)) {
        warnings.push(
          `Matched deal ${existing.id} is in unmanaged pipeline ${existingPipeline}; creating a new deal instead.`,
        );
        const created = await client.createDeal(properties);
        actions.push("create_deal_pipeline_guard");
        return { action: "create", id: created.id };
      }

      const pipelineConfig = DEAL_MATCH_PIPELINES[existingPipeline];
      const updateProperties: Record<string, string> = {};

      // Stamp Givebutter identity and key fields onto the pre-created deal.
      if (properties.givebutter_transaction_id) {
        updateProperties.givebutter_transaction_id = properties.givebutter_transaction_id;
      }
      if (properties.givebutter_reference_number) {
        updateProperties.givebutter_reference_number = properties.givebutter_reference_number;
      }
      if (properties.amount) updateProperties.amount = properties.amount;
      if (properties.closedate) updateProperties.closedate = properties.closedate;
      if (properties.givebutter_campaign) updateProperties.givebutter_campaign = properties.givebutter_campaign;
      if (properties.givebutter_company_name) updateProperties.givebutter_company_name = properties.givebutter_company_name;
      if (properties.givebutter_message) updateProperties.givebutter_message = properties.givebutter_message;

      if (matchResult.decision === "auto_close") {
        // Close in the deal's own pipeline's closed stage — do not overwrite pipeline.
        updateProperties.dealstage = pipelineConfig.closedStageId;
        updateProperties.deal_match_status = "auto_closed";
        if (matchResult.score !== undefined) {
          updateProperties.deal_match_score = String(matchResult.score);
        }
        if (matchResult.signals.length > 0) {
          updateProperties.deal_match_signals = matchResult.signals.join(",");
        }
      }

      const updated = await client.updateDeal(existing.id, updateProperties);
      actions.push("update_deal");
      return { action: "update", id: updated.id };
    }

    // Deal was found via idempotency key: full property update (original behavior).
    const updateProperties = { ...properties };
    delete updateProperties.createdate;
    const updated = await client.updateDeal(existing.id, updateProperties);
    actions.push("update_deal");
    return { action: "update", id: updated.id };
  }

  const created = await client.createDeal(properties);
  actions.push("create_deal");
  return { action: "create", id: created.id };
}

async function associateChapterPath(
  client: DonationParityClient,
  contactId: string,
  dealId: string,
  chapterCompany: HubSpotCompany,
  actions: string[],
  warnings: string[],
): Promise<void> {
  await client.associateDealToCompany(dealId, chapterCompany.id);
  actions.push("associate_deal_to_chapter");

  await client.associateContactToDealWithType(
    contactId,
    dealId,
    CHAPTER_FINANCIAL_DONOR_ASSOCIATION_TYPE_ID,
  );
  actions.push("add_chapter_financial_donor_association");

  const chapterLeadId = await findChapterLeadContactId(client, chapterCompany.id, warnings);

  if (chapterLeadId) {
    await client.associateContactToDealWithType(
      chapterLeadId,
      dealId,
      CHAPTER_DONATION_CONTACT_ASSOCIATION_TYPE_ID,
    );
    actions.push("add_chapter_donation_contact_association");
  }
}

async function findChapterLeadContactId(
  client: DonationParityClient,
  chapterCompanyId: string,
  warnings: string[],
): Promise<string | null> {
  const associations = await client.getCompanyContactAssociations(chapterCompanyId);
  const leads = associations.filter((association) =>
    association.associationTypes?.some(
      (type) => type.typeId === COMPANY_DONATION_CONTACT_ASSOCIATION_TYPE_ID,
    ),
  );

  if (leads.length > 1) {
    warnings.push(
      `Chapter company ${chapterCompanyId} has multiple Donation Contact associations; using the first.`,
    );
  }

  if (leads.length === 0) {
    warnings.push(`Chapter company ${chapterCompanyId} has no Donation Contact association.`);
    return null;
  }

  return String(leads[0].toObjectId);
}

async function processDonorCompany(
  client: DonationParityClient,
  companyName: string | null,
  contactId: string | null,
  dealId: string | null,
  mode: DonationParityMode,
  actions: string[],
  warnings: string[],
): Promise<ObjectOutcome | null> {
  if (!companyName?.trim()) {
    return null;
  }

  const existing = await findFirstCompany(
    client,
    "name",
    companyName,
    warnings,
    "donor company",
  );

  if (mode === "shadow") {
    const action = existing ? "would_update" : "would_create";
    actions.push(existing ? "would_use_existing_donor_company" : "would_create_donor_company");
    actions.push("would_associate_contact_to_donor_company", "would_associate_deal_to_donor_company");
    return { action, id: existing?.id ?? null };
  }

  if (!contactId || !dealId) {
    throw new Error("Cannot associate donor company without contact and deal IDs.");
  }

  const company = existing ?? (await client.createCompany({ name: companyName.trim() }));
  actions.push(existing ? "use_existing_donor_company" : "create_donor_company");

  await client.associateContactToCompany(contactId, company.id);
  await client.associateDealToCompany(dealId, company.id);
  actions.push("associate_contact_to_donor_company", "associate_deal_to_donor_company");

  return { action: existing ? "use_existing" : "create", id: company.id };
}

async function findFirstCompany(
  client: DonationParityClient,
  propertyName: string,
  value: string | null,
  warnings: string[],
  description: string,
): Promise<HubSpotCompany | null> {
  if (!value?.trim()) {
    return null;
  }

  const results = await client.searchCompanies(propertyName, value.trim(), [
    "name",
    "givebutter_code",
    "record_type",
  ]);

  return firstResult(results, warnings, description);
}

function firstResult<T extends { id: string }>(
  results: T[],
  warnings: string[],
  description: string,
): T | null {
  if (results.length > 1) {
    warnings.push(`Multiple HubSpot records matched ${description}; using the first result.`);
  }

  return results[0] ?? null;
}

function compactProperties(
  properties: Record<string, string | number | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
      .map(([key, value]) => [key, String(value)]),
  );
}

function asString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function isNumericIdentifier(value: string | null): value is string {
  return Boolean(value && /^\d+$/.test(value));
}

function needsAttention(
  mode: DonationParityMode,
  donation: GivebutterDonation,
  reason: string,
): DonationParityResult {
  return {
    status: "needs_attention",
    mode,
    transactionId: asString(donation.transactionId),
    referenceNumber: asString(donation.transactionNumber),
    actions: [],
    warnings: [],
    reason,
  };
}
