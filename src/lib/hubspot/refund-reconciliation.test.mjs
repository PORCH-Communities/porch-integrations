import assert from "node:assert/strict";
import test from "node:test";

import { processGivebutterRefund } from "./refund-reconciliation.ts";

const refund = {
  eventId: "event-1",
  refundId: 89700,
  transactionId: 32777319,
  status: "succeeded",
  type: "full",
  amount: 25,
  reason: "customer_request",
  method: "card",
  createdAt: "2026-07-01 11:22:15",
};

function givebutterFetch(transactions) {
  return async () => new Response(JSON.stringify({ data: transactions, links: { next: null } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const parent = {
  id: "6229vBpcr0URg3Kg",
  number: "5173983024",
  amount: 25,
  payment_method: "card",
  created_at: "2026-06-30T17:29:19+00:00",
  transactions: [{ amount: 25, refunded: true, refunded_at: "2026-07-01T11:22:15+00:00" }],
};

test("resolves the refund through the parent transaction and updates its HubSpot deal", async () => {
  const updates = [];
  const client = {
    async searchDeals(property, value) {
      assert.equal(property, "givebutter_transaction_id");
      assert.equal(value, parent.id);
      return [{ id: "deal-1", properties: { amount: "25", gb_refunded_amount: null, gb_processed_refund_ids: null } }];
    },
    async updateDealProperties(id, properties) { updates.push([id, properties]); },
  };

  const result = await processGivebutterRefund(client, refund, {
    apiKey: "test",
    fetchImpl: givebutterFetch([parent]),
  });

  assert.equal(result.status, "updated");
  assert.equal(result.netAmount, 0);
  assert.equal(updates[0][1].gb_refunded_amount, "25");
  assert.equal(updates[0][1].gb_processed_refund_ids, "89700");
});

test("does not apply the same refund twice", async () => {
  let updated = false;
  const client = {
    async searchDeals() {
      return [{ id: "deal-1", properties: { amount: "25", gb_refunded_amount: "25", gb_processed_refund_ids: "89700" } }];
    },
    async updateDealProperties() { updated = true; },
  };

  const result = await processGivebutterRefund(client, refund, {
    apiKey: "test",
    fetchImpl: givebutterFetch([parent]),
  });

  assert.equal(result.status, "ignored_duplicate");
  assert.equal(updated, false);
});

test("refuses ambiguous parent transactions", async () => {
  const result = await processGivebutterRefund({ searchDeals() { throw new Error("should not search"); } }, refund, {
    apiKey: "test",
    fetchImpl: givebutterFetch([parent, { ...parent, id: "other", number: "123" }]),
  });

  assert.deepEqual(result, { status: "needs_attention", reason: "ambiguous_parent_transaction", candidateCount: 2 });
});

test("falls back to the Givebutter reference number when opaque ID is absent in HubSpot", async () => {
  const searches = [];
  const client = {
    async searchDeals(property, value) {
      searches.push([property, value]);
      if (property === "givebutter_reference_number") {
        return [{ id: "deal-1", properties: { amount: "25", gb_refunded_amount: "0", gb_processed_refund_ids: "" } }];
      }
      return [];
    },
    async updateDealProperties() {},
  };

  const result = await processGivebutterRefund(client, refund, {
    apiKey: "test",
    fetchImpl: givebutterFetch([parent]),
  });

  assert.equal(result.status, "updated");
  assert.deepEqual(searches.map(([property]) => property), ["givebutter_transaction_id", "givebutter_reference_number"]);
});
