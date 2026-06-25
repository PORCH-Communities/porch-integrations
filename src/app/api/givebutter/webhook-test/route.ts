import { NextRequest, NextResponse } from "next/server";

import {
  mapGivebutterCampaign,
  mapGivebutterDonation,
  parseGivebutterWebhookPayload,
  summarizeGivebutterCampaignPayload,
  summarizeGivebutterDonationPayload,
} from "@/lib/givebutter/payloads";

export const runtime = "nodejs";

export async function GET() {
  const enabled = process.env.ENABLE_GIVEBUTTER_WEBHOOK_TEST === "true";

  return NextResponse.json({
    ok: enabled,
    endpoint: "/api/givebutter/webhook-test",
    enabled,
    usage: "Temporarily enable with ENABLE_GIVEBUTTER_WEBHOOK_TEST=true. This route logs summaries only.",
  });
}

export async function POST(request: NextRequest) {
  if (process.env.ENABLE_GIVEBUTTER_WEBHOOK_TEST !== "true") {
    return NextResponse.json(
      {
        ok: false,
        error: "Webhook test endpoint is disabled.",
      },
      { status: 404 },
    );
  }

  const receivedAt = new Date().toISOString();
  const rawBody = await request.text();
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
  const summary =
    event === "transaction.succeeded"
      ? summarizeGivebutterDonationPayload(mapGivebutterDonation(payload), payload)
      : summarizeGivebutterCampaignPayload(mapGivebutterCampaign(payload), payload);
  const givebutterHeaders = getGivebutterHeaders(request);

  console.log(
    JSON.stringify({
      source: "givebutter-webhook-test",
      receivedAt,
      event,
      givebutterHeaders,
      summary,
      rawBodyBytes: Buffer.byteLength(rawBody, "utf8"),
    }),
  );

  return NextResponse.json({
    ok: true,
    receivedAt,
    summary,
    givebutterHeaders,
    rawBodyBytes: Buffer.byteLength(rawBody, "utf8"),
  });
}

function getGivebutterHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of request.headers.entries()) {
    if (key.startsWith("x-givebutter") || key.startsWith("givebutter-")) {
      headers[key] = value;
    }
  }

  return headers;
}
