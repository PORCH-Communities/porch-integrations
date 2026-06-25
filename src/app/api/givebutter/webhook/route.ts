import { NextResponse } from "next/server";

import {
  mapGivebutterCampaign,
  mapGivebutterDonation,
  parseGivebutterWebhookPayload,
  summarizeGivebutterCampaignPayload,
  summarizeGivebutterDonationPayload,
} from "@/lib/givebutter/payloads";
import { encryptPayloadForLog } from "@/lib/encrypted-payload-log";
import { verifyGivebutterWebhookSecret } from "@/lib/givebutter/webhook-secret";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/givebutter/webhook",
    mode: "dry_run",
    events: ["transaction.succeeded", "campaign.created", "campaign.updated"],
  });
}

export async function POST(request: Request) {
  const receivedAt = new Date().toISOString();
  const rawBody = await request.text();
  const verification = verifyGivebutterWebhookSecret(request.headers, rawBody);

  if (!verification.ok) {
    console.warn(
      JSON.stringify({
        source: "givebutter-webhook",
        receivedAt,
        mode: "dry_run",
        rejected: true,
        reason: verification.reason,
      }),
    );

    return NextResponse.json(
      {
        ok: false,
        receivedAt,
        error: "Webhook verification failed.",
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
    const summary = summarizeGivebutterDonationPayload(mapGivebutterDonation(payload), payload);
    const encryptedPayload = encryptPayloadForLog(rawBody);

    console.log(
      JSON.stringify({
        source: "givebutter-webhook",
        receivedAt,
        mode: "dry_run",
        event,
        verifiedBy: verification.method,
        summary,
        encryptedPayload,
      }),
    );

    return NextResponse.json({
      ok: true,
      receivedAt,
      event,
      mode: "dry_run",
    });
  }

  if (event === "campaign.created" || event === "campaign.updated") {
    const summary = summarizeGivebutterCampaignPayload(mapGivebutterCampaign(payload), payload);

    console.log(
      JSON.stringify({
        source: "givebutter-webhook",
        receivedAt,
        mode: "dry_run",
        event,
        verifiedBy: verification.method,
        summary,
      }),
    );

    return NextResponse.json({
      ok: true,
      receivedAt,
      event,
      mode: "dry_run",
    });
  }

  console.log(
    JSON.stringify({
      source: "givebutter-webhook",
      receivedAt,
      mode: "dry_run",
      event,
      verifiedBy: verification.method,
      ignored: true,
    }),
  );

  return NextResponse.json({
    ok: true,
    receivedAt,
    event,
    mode: "dry_run",
    ignored: true,
  });
}
