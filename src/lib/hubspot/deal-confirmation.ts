import type { HubSpotClient } from "./client";
import { DEAL_MATCH_PIPELINES } from "./deal-matching.ts";

// Fields Vercel copies from a holding deal onto the confirmed candidate deal.
const GIVEBUTTER_FIELDS_TO_COPY = [
  "givebutter_transaction_id",
  "givebutter_reference_number",
  "givebutter_plan_id",
  "givebutter_is_recurring",
  "recurring_communication_type",
  "recurring_anniversary_number",
  "recurring_plan_start_date",
  "givebutter_campaign",
  "givebutter_company_name",
  "givebutter_message",
  "amount",
  "closedate",
  "donor_address",
  "dedication_name",
  "dedication_type",
  "dedication_recipient_name",
  "dedication_recipient_email",
  "referrer",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
  "deal_match_score",
  "deal_match_signals",
];

type ConfirmationClient = Pick<
  HubSpotClient,
  | "getDeal"
  | "updateDeal"
  | "updateDealProperties"
  | "archiveDeal"
  | "getDealContactAssociations"
  | "getDealCompanyAssociations"
  | "associateContactToDeal"
  | "associateDealToCompany"
>;

export type DealConfirmationResult =
  | {
      status: "confirmed";
      holdingDealId: string;
      candidateDealId: string;
      copiedFields: string[];
    }
  | {
      status: "rejected";
      holdingDealId: string;
    }
  | {
      status: "ignored_not_actionable" | "needs_attention";
      dealId: string;
      reason: string;
    };

export async function processDealMatchStatusChange(
  client: ConfirmationClient,
  dealId: string,
): Promise<DealConfirmationResult> {
  const deal = await client.getDeal(dealId);
  const status = deal.properties.deal_match_status;

  if (status === "confirmed") {
    return confirmDealMatch(client, deal);
  }

  if (status === "no_match") {
    return rejectDealMatch(client, deal);
  }

  return {
    status: "ignored_not_actionable",
    dealId,
    reason: `No automated side effect for deal_match_status: ${status ?? "empty"}.`,
  };
}

async function confirmDealMatch(
  client: ConfirmationClient,
  holdingDeal: Awaited<ReturnType<HubSpotClient["getDeal"]>>,
): Promise<DealConfirmationResult> {
  const holdingDealId = holdingDeal.id;

  if (holdingDeal.properties.deal_match_status !== "confirmed") {
    return {
      status: "ignored_not_actionable",
      dealId: holdingDealId,
      reason: "Holding deal is no longer in confirmed status.",
    };
  }

  const candidateDealId = holdingDeal.properties.candidate_deal_id?.trim() ?? null;

  if (!candidateDealId) {
    return {
      status: "needs_attention",
      dealId: holdingDealId,
      reason: "Confirmed holding deal has no candidate_deal_id to merge into.",
    };
  }

  const candidateDeal = await client.getDeal(candidateDealId);

  // Guard: candidate must be in a Vercel-managed pipeline.
  const candidatePipeline = candidateDeal.properties.pipeline;

  if (!candidatePipeline || !(candidatePipeline in DEAL_MATCH_PIPELINES)) {
    return {
      status: "needs_attention",
      dealId: holdingDealId,
      reason: `Candidate deal ${candidateDealId} is in pipeline ${candidatePipeline}, which is not managed by this integration.`,
    };
  }

  // Guard: candidate must not already carry a Givebutter transaction ID.
  if (candidateDeal.properties.givebutter_transaction_id?.trim()) {
    return {
      status: "needs_attention",
      dealId: holdingDealId,
      reason: `Candidate deal ${candidateDealId} already has givebutter_transaction_id=${candidateDeal.properties.givebutter_transaction_id}. Cannot overwrite.`,
    };
  }

  // Copy Givebutter fields from holding deal to candidate deal.
  const updateProperties: Record<string, string> = {};
  const copiedFields: string[] = [];

  for (const field of GIVEBUTTER_FIELDS_TO_COPY) {
    const value = holdingDeal.properties[field]?.trim() ?? null;

    if (value) {
      updateProperties[field] = value;
      copiedFields.push(field);
    }
  }

  // Close the candidate deal in its own pipeline's closed stage.
  const pipelineConfig = DEAL_MATCH_PIPELINES[candidatePipeline];
  updateProperties.dealstage = pipelineConfig.closedStageId;
  updateProperties.deal_match_status = "auto_closed";

  // Holding deals are always suppressed while staff reviews them. Preserve
  // suppression only for routine recurring installments; initial and
  // anniversary messages become eligible when the real candidate is closed.
  if (holdingDeal.properties.recurring_communication_type === "suppressed") {
    updateProperties.suppress_automated_communications = "true";
  }

  await client.updateDeal(candidateDealId, updateProperties);

  // Re-associate the holding deal's contacts and companies to the candidate deal.
  const [holdingContacts, holdingCompanies] = await Promise.all([
    client.getDealContactAssociations(holdingDealId),
    client.getDealCompanyAssociations(holdingDealId),
  ]);

  await Promise.all([
    ...holdingContacts.map((a) =>
      client.associateContactToDeal(String(a.toObjectId), candidateDealId),
    ),
    ...holdingCompanies.map((a) =>
      client.associateDealToCompany(candidateDealId, String(a.toObjectId)),
    ),
  ]);

  // Archive the holding deal so it disappears from views.
  await client.archiveDeal(holdingDealId);

  return {
    status: "confirmed",
    holdingDealId,
    candidateDealId,
    copiedFields,
  };
}

async function rejectDealMatch(
  client: ConfirmationClient,
  holdingDeal: Awaited<ReturnType<HubSpotClient["getDeal"]>>,
): Promise<DealConfirmationResult> {
  const holdingDealId = holdingDeal.id;

  // Promote the holding deal to a standalone donation record.
  const keepSuppressed =
    holdingDeal.properties.recurring_communication_type === "suppressed";

  await client.updateDealProperties(holdingDealId, {
    pipeline: "155504019",        // Individual Donations
    dealstage: "261678424",       // Donation Complete
    deal_match_status: "no_match",
    deal_match_score: "",
    deal_match_signals: "",
    candidate_deal_id: "",
    candidate_deal_url: "",
    suppress_automated_communications: keepSuppressed ? "true" : "",
  });

  return { status: "rejected", holdingDealId };
}
