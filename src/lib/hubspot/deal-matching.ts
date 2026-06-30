import type { GivebutterDonation } from "../givebutter/payloads.ts";
import type { HubSpotClient, HubSpotDeal } from "./client";

// The three pipelines where pre-created deals may exist and where Vercel may close them.
// Any deal in a pipeline not listed here is never treated as a candidate.
export const DEAL_MATCH_PIPELINES: Record<
  string,
  { label: string; closedStageId: string; closedStageLabel: string }
> = {
  "155504019": {
    label: "Individual Donations",
    closedStageId: "261678424",
    closedStageLabel: "Donation Complete",
  },
  "802960948": {
    label: "Grant",
    closedStageId: "1363931741",
    closedStageLabel: "Grant paid",
  },
  "806689671": {
    label: "Sponsorships",
    closedStageId: "1186687809",
    closedStageLabel: "Sponsorship Complete",
  },
};

// All known closed stage IDs across the three pipelines.
const ALL_CLOSED_STAGES = new Set([
  "261678424", // Individual Donations: Donation Complete
  "261678425", // Individual Donations: Transaction Error
  "1186687803", // Individual Donations: Closed Lost
  "1363931741", // Grant: Grant paid
  "1179574046", // Grant: Grant awarded
  "1179574050", // Grant: Not awarded
  "1186687809", // Sponsorships: Sponsorship Complete
  "1186687810", // Sponsorships: Closed Lost
]);

const AUTO_CLOSE_SCORE = Number(process.env.DEAL_MATCH_AUTO_CLOSE_SCORE ?? "80");
const NEEDS_REVIEW_SCORE = Number(process.env.DEAL_MATCH_NEEDS_REVIEW_SCORE ?? "40");
const AMBIGUITY_MARGIN = Number(process.env.DEAL_MATCH_AMBIGUITY_MARGIN ?? "15");
const MAX_CANDIDATES = Number(process.env.DEAL_MATCH_MAX_CANDIDATES ?? "20");

const DEAL_CANDIDATE_PROPERTIES = [
  "pipeline",
  "dealstage",
  "amount",
  "givebutter_transaction_id",
  "givebutter_plan_id",
];

export type DealCandidate = {
  id: string;
  pipeline: string;
  dealstage: string;
  amount: string | null;
  planId: string | null;
  contactAssociated: boolean;
  companyMatched: boolean;
};

export type DealMatchDecision = "auto_close" | "needs_review" | "no_match";

export type DealMatchResult = {
  candidate: DealCandidate | null;
  decision: DealMatchDecision;
  score: number;
  signals: string[];
};

type DealMatchClient = Pick<
  HubSpotClient,
  | "searchDeals"
  | "getDeals"
  | "getCompany"
  | "getDealContactAssociations"
  | "getDealCompanyAssociations"
>;

// ─── Scoring ──────────────────────────────────────────────────────────────────

export function scoreDealCandidate(
  donation: GivebutterDonation,
  candidate: DealCandidate,
): DealMatchResult {
  const signals: string[] = [];
  let score = 0;

  if (candidate.contactAssociated) {
    score += 40;
    signals.push("contact_association");
  }

  if (donation.amount !== null && candidate.amount !== null) {
    const donationAmount = donation.amount;
    const candidateAmount = Number(candidate.amount);

    if (
      Number.isFinite(candidateAmount) &&
      candidateAmount > 0 &&
      Math.abs(donationAmount - candidateAmount) / candidateAmount <= 0.01
    ) {
      score += 50;
      signals.push("amount");
    }
  }

  if (candidate.companyMatched) {
    score += 30;
    signals.push("company_match");
  }

  return { candidate, decision: getDecision(score), score, signals };
}

export function findBestDealMatch(
  donation: GivebutterDonation,
  candidates: DealCandidate[],
): DealMatchResult {
  if (candidates.length === 0) {
    return noMatch();
  }

  const ranked = candidates
    .map((c) => scoreDealCandidate(donation, c))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  if (best.score < NEEDS_REVIEW_SCORE) {
    return noMatch();
  }

  const runnerUp = ranked[1];

  if (runnerUp && isAmbiguous(best.score, runnerUp.score)) {
    return {
      ...best,
      decision: "needs_review",
      signals: [...best.signals, "ambiguous_candidates"],
    };
  }

  return best;
}

// ─── Candidate fetch ──────────────────────────────────────────────────────────

export async function findDealCandidates(
  client: DealMatchClient,
  contactId: string | null,
  donation: GivebutterDonation,
): Promise<DealCandidate[]> {
  const candidateMap = new Map<string, HubSpotDeal>();

  // Pass 1: open deals already associated to this contact.
  if (contactId) {
    const associations = await client.getDealContactAssociations(contactId);
    const contactDealIds = associations.map((a) => String(a.toObjectId));

    if (contactDealIds.length > 0) {
      const contactDeals = await client.getDeals(contactDealIds, DEAL_CANDIDATE_PROPERTIES);

      for (const deal of contactDeals) {
        if (isEligibleCandidate(deal)) {
          candidateMap.set(deal.id, deal);
        }
      }
    }
  }

  // Pass 2: open deals matching the donation amount in any of the three pipelines.
  if (donation.amount !== null) {
    const amountDeals = await client.searchDeals(
      "amount",
      String(donation.amount),
      DEAL_CANDIDATE_PROPERTIES,
    );

    for (const deal of amountDeals) {
      if (isEligibleCandidate(deal) && !candidateMap.has(deal.id)) {
        candidateMap.set(deal.id, deal);
      }
    }
  }

  const eligible = [...candidateMap.values()].slice(0, MAX_CANDIDATES);

  const donorCompanyName = donation.companyName?.trim().toLowerCase() ?? null;

  const candidates = await Promise.all(
    eligible.map((deal) =>
      resolveCandidateSignals(client, deal, contactId, donorCompanyName),
    ),
  );

  return candidates;
}

async function resolveCandidateSignals(
  client: DealMatchClient,
  deal: HubSpotDeal,
  contactId: string | null,
  donorCompanyName: string | null,
): Promise<DealCandidate> {
  let contactAssociated = false;
  let companyMatched = false;

  if (contactId) {
    const dealContacts = await client.getDealContactAssociations(deal.id);
    contactAssociated = dealContacts.some(
      (a) => String(a.toObjectId) === contactId,
    );
  }

  if (donorCompanyName) {
    const dealCompanyAssocs = await client.getDealCompanyAssociations(deal.id);
    const companyIds = dealCompanyAssocs.map((a) => String(a.toObjectId));

    for (const companyId of companyIds) {
      const company = await client.getCompany(companyId);
      const storedName = (company.properties.name ?? "").trim().toLowerCase();

      if (storedName && storedName === donorCompanyName) {
        companyMatched = true;
        break;
      }
    }
  }

  return {
    id: deal.id,
    pipeline: deal.properties.pipeline ?? "",
    dealstage: deal.properties.dealstage ?? "",
    amount: deal.properties.amount ?? null,
    planId: deal.properties.givebutter_plan_id?.trim() || null,
    contactAssociated,
    companyMatched,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isEligibleCandidate(deal: HubSpotDeal): boolean {
  const pipeline = deal.properties.pipeline;
  const stage = deal.properties.dealstage;

  if (!pipeline || !(pipeline in DEAL_MATCH_PIPELINES)) return false;
  if (!stage || ALL_CLOSED_STAGES.has(stage)) return false;
  if (deal.properties.givebutter_transaction_id?.trim()) return false;

  return true;
}

function getDecision(score: number): DealMatchDecision {
  if (score >= AUTO_CLOSE_SCORE) return "auto_close";
  if (score >= NEEDS_REVIEW_SCORE) return "needs_review";
  return "no_match";
}

function isAmbiguous(bestScore: number, runnerUpScore: number): boolean {
  if (runnerUpScore >= AUTO_CLOSE_SCORE) return true;
  return runnerUpScore >= NEEDS_REVIEW_SCORE && bestScore - runnerUpScore <= AMBIGUITY_MARGIN;
}

function noMatch(): DealMatchResult {
  return { candidate: null, decision: "no_match", score: 0, signals: [] };
}
