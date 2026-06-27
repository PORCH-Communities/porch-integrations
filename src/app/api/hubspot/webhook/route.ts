import { NextResponse } from "next/server";

import { createHubSpotClient, HubSpotApiError } from "@/lib/hubspot/client";
import { confirmContactHousehold } from "@/lib/hubspot/household-confirmation";
import { getHubSpotRequestUri, verifyHubSpotV3Signature } from "@/lib/hubspot/signature";

export const runtime = "nodejs";

type HubSpotWebhookEvent = {
  eventId?: number;
  objectId?: number | string;
  objectTypeId?: string;
  propertyName?: string;
  propertyValue?: string;
  subscriptionType?: string;
};

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/hubspot/webhook",
    subscription: "contact.household_match_status property changes",
  });
}

export async function POST(request: Request) {
  const receivedAt = new Date().toISOString();
  const rawBody = await request.text();
  const verification = verifyHubSpotV3Signature({
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
    method: request.method,
    uri: getHubSpotRequestUri(request),
    rawBody,
    signature: request.headers.get("x-hubspot-signature-v3"),
    timestamp: request.headers.get("x-hubspot-request-timestamp"),
  });

  if (!verification.ok) {
    console.warn(
      JSON.stringify({
        source: "hubspot-webhook",
        receivedAt,
        rejected: true,
        reason: verification.reason,
      }),
    );

    return NextResponse.json(
      { ok: false, error: "Webhook verification failed.", reason: verification.reason },
      { status: verification.reason === "missing_config" ? 500 : 401 },
    );
  }

  const events = parseWebhookEvents(rawBody);

  if (!events) {
    return NextResponse.json({ ok: false, error: "Invalid webhook payload." }, { status: 400 });
  }

  const contactIds = [
    ...new Set(
      events
        .filter(isConfirmedHouseholdEvent)
        .map((event) => String(event.objectId))
        .filter(Boolean),
    ),
  ];

  if (contactIds.length === 0) {
    return NextResponse.json({ ok: true, receivedAt, received: events.length, ignored: true });
  }

  try {
    const client = createHubSpotClient();
    const results = [];

    for (const contactId of contactIds) {
      results.push(await confirmContactHousehold(client, contactId));
    }

    console.log(
      JSON.stringify({
        source: "hubspot-webhook",
        receivedAt,
        received: events.length,
        processed: results.length,
        results,
      }),
    );

    return NextResponse.json({
      ok: true,
      receivedAt,
      received: events.length,
      processed: results.length,
      results,
    });
  } catch (error) {
    const retryable = error instanceof HubSpotApiError ? error.retryable : true;

    console.error(
      JSON.stringify({
        source: "hubspot-webhook",
        receivedAt,
        failed: true,
        retryable,
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { ok: false, error: "Household confirmation processing failed.", retryable },
      { status: retryable ? 503 : 200 },
    );
  }
}

function parseWebhookEvents(rawBody: string): HubSpotWebhookEvent[] | null {
  try {
    const value = JSON.parse(rawBody) as unknown;

    return Array.isArray(value) ? (value as HubSpotWebhookEvent[]) : null;
  } catch {
    return null;
  }
}

function isConfirmedHouseholdEvent(event: HubSpotWebhookEvent): boolean {
  return (
    event.objectId !== undefined &&
    event.objectTypeId === "0-1" &&
    event.propertyName === "household_match_status" &&
    event.propertyValue === "confirmed" &&
    (event.subscriptionType === "object.propertyChange" ||
      event.subscriptionType === "contact.propertyChange")
  );
}
