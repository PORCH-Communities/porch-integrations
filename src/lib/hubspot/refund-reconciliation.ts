import type { GivebutterRefund } from "../givebutter/refund-payload";
import type { HubSpotClient, HubSpotDeal } from "./client";

const GIVEBUTTER_TRANSACTIONS_URL = "https://api.givebutter.com/v1/transactions?limit=25";
const REFUND_DEAL_PROPERTIES = [
  "amount",
  "givebutter_transaction_id",
  "givebutter_reference_number",
  "gb_refunded_amount",
  "gb_processed_refund_ids",
];

type JsonRecord = Record<string, unknown>;

export type RefundReconciliationResult =
  | { status: "updated"; dealId: string; transactionId: string; transactionNumber: string; refundedAmount: number; netAmount: number }
  | { status: "ignored_duplicate"; dealId: string; refundId: string }
  | { status: "needs_attention"; reason: string; candidateCount?: number };

export async function processGivebutterRefund(
  client: HubSpotClient,
  refund: GivebutterRefund,
  options?: { apiKey?: string; fetchImpl?: typeof fetch },
): Promise<RefundReconciliationResult> {
  const refundId = asString(refund.refundId);
  const apiKey = options?.apiKey ?? process.env.GIVEBUTTER_API_KEY;

  if (!refundId || refund.amount === null || !refund.createdAt) {
    return { status: "needs_attention", reason: "refund_missing_required_fields" };
  }

  if (!apiKey) {
    throw new Error("Missing required environment variable: GIVEBUTTER_API_KEY");
  }

  const parents = await findRefundedTransactions(refund, apiKey, options?.fetchImpl ?? fetch);

  if (parents.length !== 1) {
    return {
      status: "needs_attention",
      reason: parents.length === 0 ? "parent_transaction_not_found" : "ambiguous_parent_transaction",
      candidateCount: parents.length,
    };
  }

  const parent = parents[0];
  const dealsById = await client.searchDeals(
    "givebutter_transaction_id",
    parent.id,
    REFUND_DEAL_PROPERTIES,
  );
  const deals = dealsById.length > 0
    ? dealsById
    : await client.searchDeals(
        "givebutter_reference_number",
        parent.number,
        REFUND_DEAL_PROPERTIES,
      );

  if (deals.length !== 1) {
    return {
      status: "needs_attention",
      reason: deals.length === 0 ? "hubspot_deal_not_found" : "ambiguous_hubspot_deal",
      candidateCount: deals.length,
    };
  }

  return applyRefundToDeal(client, deals[0], refund, refundId, parent);
}

async function applyRefundToDeal(
  client: HubSpotClient,
  deal: HubSpotDeal,
  refund: GivebutterRefund,
  refundId: string,
  parent: ParentTransaction,
): Promise<RefundReconciliationResult> {
  const processedIds = parseIds(deal.properties.gb_processed_refund_ids);

  if (processedIds.has(refundId)) {
    return { status: "ignored_duplicate", dealId: deal.id, refundId };
  }

  const grossAmount = finiteNumber(deal.properties.amount);
  const priorRefundedAmount = finiteNumber(deal.properties.gb_refunded_amount) ?? 0;

  if (grossAmount === null) {
    return { status: "needs_attention", reason: "hubspot_deal_missing_amount" };
  }

  const refundedAmount = roundCurrency(priorRefundedAmount + (refund.amount ?? 0));
  const netAmount = roundCurrency(grossAmount - refundedAmount);
  processedIds.add(refundId);

  await client.updateDealProperties(deal.id, {
    gb_refunded_amount: String(refundedAmount),
    gb_refund_date: normalizeDate(refund.createdAt!),
    gb_refund_reason: refund.reason ?? "",
    gb_refund_status: refund.status ?? "",
    gb_net_donation_amount: String(netAmount),
    gb_processed_refund_ids: [...processedIds].join(","),
  });

  return {
    status: "updated",
    dealId: deal.id,
    transactionId: parent.id,
    transactionNumber: parent.number,
    refundedAmount,
    netAmount,
  };
}

type ParentTransaction = {
  id: string;
  number: string;
};

async function findRefundedTransactions(
  refund: GivebutterRefund,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<ParentTransaction[]> {
  const refundTime = Date.parse(normalizeDate(refund.createdAt!));
  const candidates = new Map<string, ParentTransaction>();
  let url: string | null = GIVEBUTTER_TRANSACTIONS_URL;
  let page = 0;

  while (url && page < 10) {
    page += 1;
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      throw new Error(`Givebutter transaction lookup failed with ${response.status}`);
    }

    const body = (await response.json()) as JsonRecord;
    const transactions = Array.isArray(body.data) ? body.data : [];

    for (const value of transactions) {
      const transaction = asRecord(value);
      if (!transaction) continue;

      const id = asString(transaction.id);
      const number = asString(transaction.number);
      const method = asString(transaction.payment_method) ?? asString(transaction.method);
      const children = Array.isArray(transaction.transactions) ? transaction.transactions : [];
      const matchingChild = children.map(asRecord).find((child) => {
        if (!child || child.refunded !== true) return false;
        const refundedAt = Date.parse(asString(child.refunded_at) ?? "");
        if (!Number.isFinite(refundedAt) || Math.abs(refundedAt - refundTime) > 120_000) return false;
        if (refund.method && method && refund.method !== method) return false;
        if (refund.type === "full") {
          const amount = finiteNumber(child.amount) ?? finiteNumber(transaction.amount);
          if (amount !== null && refund.amount !== null && Math.abs(amount - refund.amount) > 0.01) return false;
        }
        return true;
      });

      if (id && number && matchingChild) candidates.set(id, { id, number });
    }

    const oldestCreatedAt = transactions
      .map(asRecord)
      .map((transaction) => Date.parse(asString(transaction?.created_at) ?? ""))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];

    if (oldestCreatedAt !== undefined && oldestCreatedAt < refundTime - 7 * 86_400_000) break;
    url = asString(asRecord(body.links)?.next);
  }

  return [...candidates.values()];
}

function normalizeDate(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return new Date(normalized).toISOString();
}

function parseIds(value: unknown): Set<string> {
  return new Set((asString(value) ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
