import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTransactionLogEmail,
  sendTransactionLogEmail,
} from "./transaction-log-email.ts";

const donation = {
  eventId: "event-123",
  transactionId: "transaction-123",
  transactionNumber: "1234567890",
  contactId: 1,
  planId: "plan-1",
  donorType: "person",
  firstName: "Test",
  lastName: "Donor",
  email: "donor@example.org",
  phone: null,
  companyName: null,
  paymentMethod: "card",
  isOffline: false,
  isRecurring: true,
  amount: 25,
  feeCovered: 0,
  currency: "USD",
  status: "succeeded",
  campaignId: 1,
  campaignCode: "ABC123",
  campaignTitle: "Test Campaign",
  createdAt: "2026-07-01T12:00:00Z",
  transactedAt: "2026-07-01T12:00:00Z",
  message: null,
  childTransactionCount: 1,
  hasFeeLineItem: false,
  dedication: { type: null, name: null, recipientName: null, recipientEmail: null },
  address: { company: null, line1: null, line2: null, city: null, state: null, postalCode: null, country: null },
  utm: { referrer: null, campaign: null, content: null, medium: null, source: null, term: null },
};

const result = {
  status: "processed",
  mode: "write",
  transactionId: "transaction-123",
  referenceNumber: "1234567890",
  deal: { action: "create", id: "deal-123" },
  destination: "Chapter",
  recurringCommunication: { type: "suppressed", reason: "routine_installment" },
  actions: [],
  warnings: [],
};

test("builds a brief, stable transaction log without address or phone", () => {
  const log = buildTransactionLogEmail(
    { donation, result, receivedAt: "2026-07-01T12:00:01Z" },
    { from: "from@example.org", to: ["to@example.org"] },
  );

  assert.equal(log.idempotencyKey, "givebutter-transaction-log/event-123");
  assert.match(log.email.subject, /\$25\.00/);
  assert.match(log.email.text, /Recurring: yes \(suppressed\)/);
  assert.match(log.email.text, /HubSpot Deal ID: deal-123/);
  assert.doesNotMatch(log.email.text, /donor@example\.org/);
});

test("passes a stable idempotency key to Resend", async () => {
  const calls = [];
  const sender = {
    async send(email, options) {
      calls.push([email, options]);
      return { data: { id: "email-123" }, error: null };
    },
  };

  const sent = await sendTransactionLogEmail(
    { donation, result, receivedAt: "2026-07-01T12:00:01Z" },
    { sender, from: "from@example.org", to: ["to@example.org"] },
  );

  assert.deepEqual(sent, { status: "sent", emailId: "email-123" });
  assert.equal(calls[0][1].idempotencyKey, "givebutter-transaction-log/event-123");
});

test("returns failed instead of throwing when Resend rejects the email", async () => {
  const sender = {
    async send() {
      return { data: null, error: { message: "domain not verified" } };
    },
  };

  const sent = await sendTransactionLogEmail(
    { donation, result, receivedAt: "2026-07-01T12:00:01Z" },
    { sender, from: "from@example.org", to: ["to@example.org"] },
  );

  assert.deepEqual(sent, { status: "failed", message: "domain not verified" });
});
