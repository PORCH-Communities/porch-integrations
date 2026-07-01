import { readFile } from "node:fs/promises";

import { mapGivebutterDonation } from "../src/lib/givebutter/payloads.ts";
import { sendTransactionLogEmail } from "../src/lib/givebutter/transaction-log-email.ts";

const path = process.argv[2];

if (!path) {
  console.error("Usage: node --experimental-strip-types --env-file=.env scripts/test-transaction-log-email.mjs <captured-payload.json>");
  process.exit(1);
}

const stored = JSON.parse(await readFile(path, "utf8"));
const payload = stored.payload ?? stored;
const donation = mapGivebutterDonation(payload);
donation.eventId = `${donation.eventId ?? "test"}-test-${Date.now()}`;
const receivedAt = stored.receivedAt ?? new Date().toISOString();

// Synthetic result — this script only exercises the email path, not live HubSpot writes.
const result = {
  status: "processed",
  mode: "shadow",
  transactionId: String(donation.transactionId ?? "test"),
  referenceNumber: donation.transactionNumber ? String(donation.transactionNumber) : null,
  destination: "PORCH-Communities",
  recurringCommunication: donation.isRecurring ? { type: "recurring_charge" } : null,
  deal: { id: "TEST-DEAL-ID" },
  actions: ["test-run"],
  warnings: [],
};

const emailResult = await sendTransactionLogEmail({ donation, result, receivedAt });

console.log(JSON.stringify({ donation, result, emailResult }, null, 2));
