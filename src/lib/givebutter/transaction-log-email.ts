import { Resend } from "resend";

import type { GivebutterDonation } from "./payloads";
import type { DonationParityResult } from "../hubspot/donation-parity";

const DEFAULT_TO = "admin@porchcommunities.org";
const DEFAULT_FROM = "PORCH Integrations <onboarding@resend.dev>";

type EmailSender = {
  send(
    message: { from: string; to: string[]; subject: string; text: string },
    options: { idempotencyKey: string },
  ): Promise<{ data?: { id?: string | null } | null; error?: unknown }>;
};

export type TransactionLogEmailResult =
  | { status: "sent"; emailId: string | null }
  | { status: "disabled"; reason: "missing_api_key" }
  | { status: "failed"; message: string };

export async function sendTransactionLogEmail(
  input: {
    donation: GivebutterDonation;
    result: DonationParityResult;
    receivedAt: string;
  },
  options?: {
    apiKey?: string;
    from?: string;
    to?: string[];
    sender?: EmailSender;
  },
): Promise<TransactionLogEmailResult> {
  const apiKey = options?.apiKey ?? process.env.RESEND_API_KEY;

  if (!apiKey && !options?.sender) {
    return { status: "disabled", reason: "missing_api_key" };
  }

  const sender = options?.sender ?? new Resend(apiKey).emails;
  const message = buildTransactionLogEmail(input, {
    from: options?.from ?? process.env.TRANSACTION_LOG_EMAIL_FROM ?? DEFAULT_FROM,
    to: options?.to ?? parseRecipients(process.env.TRANSACTION_LOG_EMAIL_TO),
  });

  try {
    const response = await sender.send(message.email, {
      idempotencyKey: message.idempotencyKey,
    });

    if (response.error) {
      return { status: "failed", message: getErrorMessage(response.error) };
    }

    return { status: "sent", emailId: response.data?.id ?? null };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown Resend error",
    };
  }
}

export function buildTransactionLogEmail(
  input: {
    donation: GivebutterDonation;
    result: DonationParityResult;
    receivedAt: string;
  },
  delivery: { from: string; to: string[] },
) {
  const { donation, result, receivedAt } = input;
  const reference = asString(donation.transactionNumber) ?? "unknown-reference";
  const identity = asString(donation.eventId) ?? asString(donation.transactionId) ?? reference;
  const donorName = [donation.firstName, donation.lastName].filter(Boolean).join(" ") || "Unknown donor";
  const amount = formatAmount(donation.amount, donation.currency);
  const recurringType = result.recurringCommunication?.type ?? "not_recurring";
  const dealId = result.deal?.id ?? "none";

  return {
    idempotencyKey: `givebutter-transaction-log/${identity}`,
    email: {
      from: delivery.from,
      to: delivery.to,
      subject: `[Givebutter] ${amount} — ${donorName} — ${result.status}`,
      text: [
        `Received: ${receivedAt}`,
        `Donor: ${donorName}`,
        `Amount: ${amount}`,
        `Reference: ${reference}`,
        `Transaction ID: ${asString(donation.transactionId) ?? "unknown"}`,
        `Campaign: ${donation.campaignTitle ?? donation.campaignCode ?? "unknown"}`,
        `Destination: ${result.destination ?? "unknown"}`,
        `Recurring: ${donation.isRecurring ? "yes" : "no"} (${recurringType})`,
        `Result: ${result.status}`,
        `HubSpot Deal ID: ${dealId}`,
        result.warnings.length > 0 ? `Warnings: ${result.warnings.join(" | ")}` : "Warnings: none",
      ].join("\n"),
    },
  };
}

function parseRecipients(value: string | undefined): string[] {
  const recipients = value?.split(",").map((email) => email.trim()).filter(Boolean) ?? [];
  return recipients.length > 0 ? recipients : [DEFAULT_TO];
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) return "Unknown amount";

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
    }).format(amount);
  } catch {
    return `${amount} ${currency ?? "USD"}`;
  }
}

function asString(value: string | number | null | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }

  return "Resend rejected the email";
}
