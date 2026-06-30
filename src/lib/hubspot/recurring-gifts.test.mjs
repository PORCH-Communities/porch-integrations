import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecurringDealProperties,
  resolveRecurringCommunication,
} from "./recurring-gifts.ts";

test("does nothing for a one-time gift", async () => {
  const client = {
    async searchDeals() {
      throw new Error("should not search");
    },
  };

  assert.equal(
    await resolveRecurringCommunication(client, makeDonation({ isRecurring: false })),
    null,
  );
});

test("routes the first successful installment to the initial workflow", async () => {
  const result = await resolveRecurringCommunication(
    makeClient([]),
    makeDonation({ transactedAt: "2026-01-15T12:00:00.000Z" }),
  );

  assert.deepEqual(result, {
    type: "initial",
    planStartDate: "2026-01-15",
    anniversaryNumber: null,
    suppressAutomatedCommunications: false,
    reason: "first_installment",
  });
});

test("suppresses a routine monthly installment", async () => {
  const result = await resolveRecurringCommunication(
    makeClient([makeDeal({ closedate: "2026-01-15", transactionId: "txn-1" })]),
    makeDonation({ transactionId: "txn-2", transactedAt: "2026-02-15T12:00:00.000Z" }),
  );

  assert.equal(result.type, "suppressed");
  assert.equal(result.planStartDate, "2026-01-15");
  assert.equal(result.suppressAutomatedCommunications, true);
});

test("routes the first installment after an anniversary", async () => {
  const result = await resolveRecurringCommunication(
    makeClient([
      makeDeal({ closedate: "2025-01-15", transactionId: "txn-1" }),
      makeDeal({ closedate: "2025-12-15", transactionId: "txn-12" }),
    ]),
    makeDonation({ transactionId: "txn-13", transactedAt: "2026-01-16T12:00:00.000Z" }),
  );

  assert.deepEqual(result, {
    type: "anniversary",
    planStartDate: "2025-01-15",
    anniversaryNumber: 1,
    suppressAutomatedCommunications: false,
    reason: "first_installment_after_anniversary",
  });
});

test("does not send the same anniversary twice", async () => {
  const result = await resolveRecurringCommunication(
    makeClient([
      makeDeal({ closedate: "2025-01-15", transactionId: "txn-1" }),
      makeDeal({
        closedate: "2026-01-16",
        transactionId: "txn-13",
        communicationType: "anniversary",
        anniversaryNumber: "1",
      }),
    ]),
    makeDonation({ transactionId: "txn-14", transactedAt: "2026-02-15T12:00:00.000Z" }),
  );

  assert.equal(result.type, "suppressed");
});

test("suppresses a resumed plan outside the anniversary window", async () => {
  const result = await resolveRecurringCommunication(
    makeClient([makeDeal({ closedate: "2025-01-15", transactionId: "txn-1" })]),
    makeDonation({ transactionId: "txn-late", transactedAt: "2026-04-01T12:00:00.000Z" }),
  );

  assert.equal(result.type, "suppressed");
  assert.equal(result.reason, "outside_anniversary_window");
});

test("preserves a stored communication decision on webhook retry", async () => {
  const result = await resolveRecurringCommunication(
    makeClient([
      makeDeal({
        closedate: "2026-01-16",
        transactionId: "txn-current",
        communicationType: "anniversary",
        anniversaryNumber: "2",
        planStartDate: "2024-01-15",
      }),
    ]),
    makeDonation({ transactionId: "txn-current", transactedAt: "2026-01-16T12:00:00.000Z" }),
  );

  assert.equal(result.type, "anniversary");
  assert.equal(result.anniversaryNumber, 2);
  assert.equal(result.reason, "idempotent_retry");
});

test("does not count an open pre-created plan deal as a prior installment", async () => {
  const result = await resolveRecurringCommunication(
    makeClient([makeDeal({ closedate: null, transactionId: null })]),
    makeDonation(),
  );

  assert.equal(result.type, "initial");
});

test("suppresses recurring gifts that lack a plan ID", async () => {
  const result = await resolveRecurringCommunication(
    makeClient([]),
    makeDonation({ planId: null }),
  );

  assert.equal(result.type, "suppressed");
  assert.equal(result.reason, "missing_plan_id");
});

test("builds HubSpot routing fields and only sets global suppression when required", () => {
  assert.deepEqual(
    buildRecurringDealProperties({
      type: "anniversary",
      planStartDate: "2025-01-15",
      anniversaryNumber: 1,
      suppressAutomatedCommunications: false,
      reason: "test",
    }),
    {
      recurring_communication_type: "anniversary",
      recurring_plan_start_date: "2025-01-15",
      recurring_anniversary_number: "1",
    },
  );

  assert.equal(
    buildRecurringDealProperties({
      type: "suppressed",
      planStartDate: "2025-01-15",
      anniversaryNumber: null,
      suppressAutomatedCommunications: true,
      reason: "test",
    }).suppress_automated_communications,
    "true",
  );
});

function makeClient(deals) {
  return {
    async searchDeals(propertyName, value) {
      assert.equal(propertyName, "givebutter_plan_id");
      assert.equal(value, "plan-1");
      return deals;
    },
  };
}

function makeDeal({
  closedate,
  transactionId,
  communicationType = null,
  anniversaryNumber = null,
  planStartDate = null,
}) {
  return {
    id: transactionId ?? "pre-created",
    properties: {
      closedate,
      givebutter_transaction_id: transactionId,
      recurring_communication_type: communicationType,
      recurring_anniversary_number: anniversaryNumber,
      recurring_plan_start_date: planStartDate,
    },
  };
}

function makeDonation(overrides = {}) {
  return {
    transactionId: "txn-current",
    planId: "plan-1",
    isRecurring: true,
    createdAt: "2026-01-15T12:00:00.000Z",
    transactedAt: "2026-01-15T12:00:00.000Z",
    ...overrides,
  };
}
