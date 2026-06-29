import { NextResponse } from "next/server";

import {
  mapGivebutterCampaign,
  mapGivebutterDonation,
  parseGivebutterWebhookPayload,
  summarizeGivebutterCampaignPayload,
  summarizeGivebutterDonationPayload,
} from "@/lib/givebutter/payloads";
import { createHubSpotClient, HubSpotApiError } from "@/lib/hubspot/client";
import {
  getDonationParityMode,
  processGivebutterDonation,
} from "@/lib/hubspot/donation-parity";
import { persistPayloadLog } from "@/lib/persisted-payload-log";
import { verifyGivebutterWebhookSecret } from "@/lib/givebutter/webhook-secret";

export const runtime = "nodejs";

export async function GET() {
  const mode = getDonationParityMode();

  return NextResponse.json({
    ok: true,
    endpoint: "/api/givebutter/webhook",
    mode,
    events: ["transaction.succeeded", "refund.created", "campaign.created", "campaign.updated"],
  });
}

export async function POST(request: Request) {
  const receivedAt = new Date().toISOString();
  const rawBody = await request.text();
  const verification = verifyGivebutterWebhookSecret(request.headers, rawBody);

  if (!verification.ok) {
    const diagnosticHeaders = getWebhookDiagnosticHeaders(request.headers);

    console.warn(
      JSON.stringify({
        source: "givebutter-webhook",
        receivedAt,
        mode: getDonationParityMode(),
        rejected: true,
        reason: verification.reason,
        diagnosticHeaders,
      }),
    );

    return NextResponse.json(
      {
        ok: false,
        receivedAt,
        error: "Webhook verification failed.",
        reason: verification.reason,
        diagnosticHeaders,
      },
      { status: verification.reason === "missing_config" ? 500 : 401 },
    );
  }

  const payload = parseGivebutterWebhookPayload(rawBody);

  if (!payload) {
    return NextResponse.json(
      {
        ok: false,
        receivedAt,
        error: "Invalid JSON webhook payload.",
      },
      { status: 400 },
    );
  }

  const event = payload.event ?? "unknown";

  if (event === "transaction.succeeded") {
    const donation = mapGivebutterDonation(payload);
    const summary = summarizeGivebutterDonationPayload(donation, payload);
    const persistedPayload = await persistPayloadLog({
      receivedAt,
      event,
      rawBody,
      summary,
    });
    const mode = getDonationParityMode();

    try {
      const result = await processGivebutterDonation(createHubSpotClient(), donation, mode);

      console.log(
        JSON.stringify({
          source: "givebutter-webhook",
          receivedAt,
          mode,
          event,
          verifiedBy: verification.method,
          summary,
          persistedPayload,
          result,
        }),
      );

      return NextResponse.json({
        ok: true,
        receivedAt,
        event,
        mode,
        status: result.status,
      });
    } catch (error) {
      const retryable = error instanceof HubSpotApiError ? error.retryable : true;

      console.error(
        JSON.stringify({
          source: "givebutter-webhook",
          receivedAt,
          mode,
          event,
          failed: true,
          retryable,
          persistedPayload,
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      );

      return NextResponse.json(
        {
          ok: false,
          receivedAt,
          event,
          mode,
          error: "Givebutter donation processing failed.",
          retryable,
        },
        { status: retryable ? 503 : 500 },
      );
    }
  }

  if (event === "refund.created") {
    const persistedPayload = await persistPayloadLog({
      receivedAt,
      event,
      rawBody,
      summary: { captured: true },
    });

    console.log(
      JSON.stringify({
        source: "givebutter-webhook",
        receivedAt,
        event,
        verifiedBy: verification.method,
        persistedPayload,
        note: "payload captured for future reconciliation — no HubSpot changes made",
      }),
    );

    return NextResponse.json({
      ok: true,
      receivedAt,
      event,
      captured: true,
    });
  }

  if (event === "campaign.created" || event === "campaign.updated") {
    const summary = summarizeGivebutterCampaignPayload(mapGivebutterCampaign(payload), payload);

    console.log(
      JSON.stringify({
        source: "givebutter-webhook",
        receivedAt,
        mode: getDonationParityMode(),
        event,
        verifiedBy: verification.method,
        summary,
      }),
    );

    return NextResponse.json({
      ok: true,
      receivedAt,
      event,
      mode: getDonationParityMode(),
    });
  }

  console.log(
    JSON.stringify({
      source: "givebutter-webhook",
      receivedAt,
      mode: getDonationParityMode(),
      event,
      verifiedBy: verification.method,
      ignored: true,
    }),
  );

  return NextResponse.json({
    ok: true,
    receivedAt,
    event,
    mode: getDonationParityMode(),
    ignored: true,
  });
}

function getWebhookDiagnosticHeaders(headers: Headers) {
  return [...headers.keys()]
    .filter((key) => {
      const normalized = key.toLowerCase();

      return (
        normalized.includes("givebutter") ||
        normalized.includes("signature") ||
        normalized.includes("webhook")
      );
    })
    .sort();
}
