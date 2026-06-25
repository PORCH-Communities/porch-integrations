const genericEmailDomains = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "icloud.com",
  "outlook.com",
  "aol.com",
  "msn.com",
  "live.com",
]);

const streetSuffixes = new Map([
  ["street", "st"],
  ["avenue", "ave"],
  ["road", "rd"],
  ["drive", "dr"],
  ["boulevard", "blvd"],
  ["lane", "ln"],
  ["court", "ct"],
  ["place", "pl"],
  ["circle", "cir"],
]);

export type MatchableContact = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  street?: string | null;
  zip?: string | null;
};

export type HouseholdCandidate = MatchableContact & {
  hubspotCompanyId: string;
  householdName: string;
};

export type HouseholdMatchResult = {
  candidate: HouseholdCandidate | null;
  decision: "auto_household" | "needs_review" | "no_match";
  score: number;
  signals: string[];
};

export function normalizeLastName(value?: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim();
}

export function normalizeZip(value?: string | null): string {
  return (value ?? "").match(/\d{5}/)?.[0] ?? "";
}

export function normalizeStreet(value?: string | null): string {
  const withoutUnit = (value ?? "")
    .toLowerCase()
    .replace(/\b(apt|apartment|unit|suite|ste|#)\b.*$/i, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return withoutUnit
    .split(" ")
    .map((part) => streetSuffixes.get(part) ?? part)
    .join(" ");
}

export function getEmailDomain(value?: string | null): string {
  const domain = (value ?? "").split("@")[1]?.toLowerCase().trim() ?? "";

  return genericEmailDomains.has(domain) ? "" : domain;
}

export function scoreHouseholdCandidate(
  contact: MatchableContact,
  candidate: HouseholdCandidate,
): HouseholdMatchResult {
  const signals: string[] = [];
  let score = 0;

  const contactLastName = normalizeLastName(contact.lastName);
  const candidateLastName = normalizeLastName(candidate.lastName);
  const contactStreet = normalizeStreet(contact.street);
  const candidateStreet = normalizeStreet(candidate.street);
  const contactZip = normalizeZip(contact.zip);
  const candidateZip = normalizeZip(candidate.zip);
  const contactEmailDomain = getEmailDomain(contact.email);
  const candidateEmailDomain = getEmailDomain(candidate.email);

  if (contactLastName && contactLastName === candidateLastName) {
    score += 40;
    signals.push("last_name");
  }

  if (contactStreet && contactStreet === candidateStreet) {
    score += 40;
    signals.push("street");
  }

  if (contactZip && contactZip === candidateZip) {
    score += 15;
    signals.push("zip");
  }

  if (contactStreet && contactStreet === candidateStreet && contactZip && contactZip === candidateZip) {
    score += 10;
    signals.push("street_zip_bonus");
  }

  if (contactEmailDomain && contactEmailDomain === candidateEmailDomain) {
    score += 20;
    signals.push("email_domain");
  }

  return {
    candidate,
    decision: getDecision(score),
    score,
    signals,
  };
}

export function findBestHouseholdMatch(
  contact: MatchableContact,
  candidates: HouseholdCandidate[],
): HouseholdMatchResult {
  if (!normalizeLastName(contact.lastName)) {
    return {
      candidate: null,
      decision: "no_match",
      score: 0,
      signals: ["missing_last_name"],
    };
  }

  const ranked = candidates
    .map((candidate) => scoreHouseholdCandidate(contact, candidate))
    .sort((a, b) => b.score - a.score);

  return (
    ranked[0] ?? {
      candidate: null,
      decision: "no_match",
      score: 0,
      signals: ["no_candidates"],
    }
  );
}

function getDecision(score: number): HouseholdMatchResult["decision"] {
  if (score >= 80) {
    return "auto_household";
  }

  if (score >= 40) {
    return "needs_review";
  }

  return "no_match";
}
