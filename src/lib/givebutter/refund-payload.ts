import type { GivebutterWebhookPayload } from "./payloads";

export type GivebutterRefund = {
  eventId: string | number | null;
  refundId: string | number | null;
  transactionId: string | number | null;
  status: string | null;
  type: "full" | "partial" | string | null;
  amount: number | null;
  reason: string | null;
  method: string | null;
  createdAt: string | null;
};

export type GivebutterRefundSummary = {
  topLevelKeys: string[];
  dataKeys: string[];
  present: Record<string, boolean>;
  missingRecommended: string[];
};

export function mapGivebutterRefund(payload: GivebutterWebhookPayload): GivebutterRefund {
  const data = asRecord(payload.data) ?? {};

  return {
    eventId: firstId(payload.id),
    refundId: firstId(data.id),
    transactionId: firstId(data.transaction_id),
    status: firstString(data.status),
    type: firstString(data.type),
    amount: firstNumber(data.amount),
    reason: firstString(data.reason),
    method: firstString(data.method),
    createdAt: firstString(data.created_at),
  };
}

export function summarizeGivebutterRefundPayload(
  refund: GivebutterRefund,
  payload: GivebutterWebhookPayload,
): GivebutterRefundSummary {
  const data = asRecord(payload.data);
  const present = {
    eventId: hasValue(refund.eventId),
    refundId: hasValue(refund.refundId),
    transactionId: hasValue(refund.transactionId),
    status: hasValue(refund.status),
    type: hasValue(refund.type),
    amount: hasValue(refund.amount),
    reason: hasValue(refund.reason),
    method: hasValue(refund.method),
    createdAt: hasValue(refund.createdAt),
  };

  return {
    topLevelKeys: Object.keys(payload).sort(),
    dataKeys: data ? Object.keys(data).sort() : [],
    present,
    missingRecommended: (["refundId", "transactionId", "amount", "status"] as const).filter(
      (key) => !present[key],
    ),
  };
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function firstId(...values: unknown[]): string | number | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }

    if (typeof value === "number") {
      return value;
    }
  }

  return null;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}
