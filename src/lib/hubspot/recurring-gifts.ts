import type { GivebutterDonation } from "../givebutter/payloads.ts";
import type { HubSpotClient, HubSpotDeal } from "./client.ts";

const ANNIVERSARY_WINDOW_DAYS = Number(
  process.env.RECURRING_ANNIVERSARY_WINDOW_DAYS ?? "45",
);

const RECURRING_DEAL_PROPERTIES = [
  "closedate",
  "givebutter_transaction_id",
  "recurring_communication_type",
  "recurring_anniversary_number",
  "recurring_plan_start_date",
];

export type RecurringCommunicationType = "initial" | "anniversary" | "suppressed";

export type RecurringCommunicationResult = {
  type: RecurringCommunicationType;
  planStartDate: string;
  anniversaryNumber: number | null;
  suppressAutomatedCommunications: boolean;
  reason: string;
};

export async function resolveRecurringCommunication(
  client: Pick<HubSpotClient, "searchDeals">,
  donation: GivebutterDonation,
): Promise<RecurringCommunicationResult | null> {
  if (!donation.isRecurring) {
    return null;
  }

  const transactionDate = toDateOnly(donation.transactedAt ?? donation.createdAt);
  const planId = asString(donation.planId);

  if (!transactionDate) {
    throw new Error("Recurring donation has no valid transaction date.");
  }

  if (!planId) {
    return {
      type: "suppressed",
      planStartDate: transactionDate,
      anniversaryNumber: null,
      suppressAutomatedCommunications: true,
      reason: "missing_plan_id",
    };
  }

  const installments = await client.searchDeals(
    "givebutter_plan_id",
    planId,
    RECURRING_DEAL_PROPERTIES,
  );
  const transactionId = asString(donation.transactionId);
  const currentDeal = installments.find(
    (deal) =>
      transactionId && deal.properties.givebutter_transaction_id?.trim() === transactionId,
  );
  const storedResult = currentDeal ? fromStoredDeal(currentDeal) : null;

  if (storedResult) {
    return storedResult;
  }

  const priorInstallments = installments.filter(
    (deal) =>
      Boolean(deal.properties.givebutter_transaction_id?.trim()) &&
      (!transactionId || deal.properties.givebutter_transaction_id?.trim() !== transactionId),
  );
  const priorDates = priorInstallments.flatMap((deal) => {
    const startDate = toDateOnly(deal.properties.recurring_plan_start_date);
    const closeDate = toDateOnly(deal.properties.closedate);

    return [startDate, closeDate].filter((value): value is string => Boolean(value));
  });
  const planStartDate = [transactionDate, ...priorDates].sort()[0];

  if (priorInstallments.length === 0) {
    return {
      type: "initial",
      planStartDate,
      anniversaryNumber: null,
      suppressAutomatedCommunications: false,
      reason: "first_installment",
    };
  }

  const anniversary = getCurrentAnniversary(planStartDate, transactionDate);

  if (
    anniversary.number >= 1 &&
    anniversary.daysSince >= 0 &&
    anniversary.daysSince <= ANNIVERSARY_WINDOW_DAYS &&
    !hasAnniversaryBeenSent(priorInstallments, anniversary.number)
  ) {
    return {
      type: "anniversary",
      planStartDate,
      anniversaryNumber: anniversary.number,
      suppressAutomatedCommunications: false,
      reason: "first_installment_after_anniversary",
    };
  }

  return {
    type: "suppressed",
    planStartDate,
    anniversaryNumber: null,
    suppressAutomatedCommunications: true,
    reason:
      anniversary.daysSince > ANNIVERSARY_WINDOW_DAYS
        ? "outside_anniversary_window"
        : "routine_installment",
  };
}

export function buildRecurringDealProperties(
  result: RecurringCommunicationResult | null,
): Record<string, string> {
  if (!result) {
    return {};
  }

  const properties: Record<string, string> = {
    recurring_communication_type: result.type,
    recurring_plan_start_date: result.planStartDate,
  };

  if (result.anniversaryNumber !== null) {
    properties.recurring_anniversary_number = String(result.anniversaryNumber);
  }

  if (result.suppressAutomatedCommunications) {
    properties.suppress_automated_communications = "true";
  }

  return properties;
}

function fromStoredDeal(deal: HubSpotDeal): RecurringCommunicationResult | null {
  const type = deal.properties.recurring_communication_type?.trim();
  const planStartDate = toDateOnly(deal.properties.recurring_plan_start_date);

  if (!isCommunicationType(type) || !planStartDate) {
    return null;
  }

  const parsedAnniversary = Number(deal.properties.recurring_anniversary_number);

  return {
    type,
    planStartDate,
    anniversaryNumber:
      type === "anniversary" && Number.isInteger(parsedAnniversary)
        ? parsedAnniversary
        : null,
    suppressAutomatedCommunications: type === "suppressed",
    reason: "idempotent_retry",
  };
}

function hasAnniversaryBeenSent(deals: HubSpotDeal[], anniversaryNumber: number): boolean {
  return deals.some(
    (deal) =>
      deal.properties.recurring_communication_type === "anniversary" &&
      Number(deal.properties.recurring_anniversary_number) === anniversaryNumber,
  );
}

function getCurrentAnniversary(
  planStartDate: string,
  transactionDate: string,
): { number: number; daysSince: number } {
  const start = parseDateOnly(planStartDate);
  const current = parseDateOnly(transactionDate);
  let number = current.getUTCFullYear() - start.getUTCFullYear();
  let anniversary = anniversaryDate(start, start.getUTCFullYear() + number);

  if (current < anniversary) {
    number -= 1;
    anniversary = anniversaryDate(start, start.getUTCFullYear() + number);
  }

  return {
    number,
    daysSince: Math.floor((current.getTime() - anniversary.getTime()) / 86_400_000),
  };
}

function anniversaryDate(start: Date, year: number): Date {
  const month = start.getUTCMonth();
  const day = Math.min(start.getUTCDate(), daysInMonth(year, month));

  return new Date(Date.UTC(year, month, day));
}

function daysInMonth(year: number, zeroBasedMonth: number): number {
  return new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate();
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);

  if (match && !Number.isNaN(parseDateOnly(match[1]).getTime())) {
    return match[1];
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function isCommunicationType(value?: string | null): value is RecurringCommunicationType {
  return value === "initial" || value === "anniversary" || value === "suppressed";
}

function asString(value: string | number | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();

  return normalized || null;
}
