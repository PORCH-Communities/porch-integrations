import { NextResponse } from "next/server";

import { createHubSpotClient, HubSpotApiError } from "@/lib/hubspot/client";
import {
  associateGivebutterDealToHousehold,
  processHouseholdStatusChange,
} from "@/lib/hubspot/household-confirmation";
import { getHubSpotRequestUri, verifyHubSpotV3Signature } from "@/lib/hubspot/signature";

export const runtime = "nodejs";

type HubSpotWebhookEvent = {
  eventId?: number;
  objectId?: number | string;
  objectTypeId?: string;
  propertyName?: string;
  propertyValue?: string;
  subscriptionType?: string;
  associationRemoved?: boolean;
  associationType?: string;
  fromObjectId?: number | string;
  fromObjectTypeId?: string;
  toObjectTypeId?: string;
};

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/hubspot/webhook",
    subscriptions: [
      "contact.household_match_status property changes",
      "deal creation",
      "deal-to-contact association additions",
    ],
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
        .filter(isHouseholdStatusEvent)
        .map((event) => String(event.objectId))
        .filter(Boolean),
    ),
  ];
  const dealIds = [
    ...new Set(
      events
        .filter(isActionableDealEvent)
        .map(getDealId)
        .filter((dealId): dealId is string => Boolean(dealId)),
    ),
  ];

  if (contactIds.length === 0 && dealIds.length === 0) {
    return NextResponse.json({ ok: true, receivedAt, received: events.length, ignored: true });
  }

  try {
    const client = createHubSpotClient();
    const contactResults = [];
    const dealResults = [];

    for (const contactId of contactIds) {
      contactResults.push(await processHouseholdStatusChange(client, contactId));
    }

    for (const dealId of dealIds) {
      dealResults.push(await associateGivebutterDealToHousehold(client, dealId));
    }

    console.log(
      JSON.stringify({
        source: "hubspot-webhook",
        receivedAt,
        received: events.length,
        processed: contactResults.length + dealResults.length,
        contactResults,
        dealResults,
      }),
    );

    return NextResponse.json({
      ok: true,
      receivedAt,
      received: events.length,
      processed: contactResults.length + dealResults.length,
      contactResults,
      dealResults,
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
      { status: retryable ? 503 : 500 },
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

function isHouseholdStatusEvent(event: HubSpotWebhookEvent): boolean {
  return (
    event.objectId !== undefined &&
    event.objectTypeId === "0-1" &&
    event.propertyName === "household_match_status" &&
    (event.subscriptionType === "object.propertyChange" ||
      event.subscriptionType === "contact.propertyChange")
  );
}

function isActionableDealEvent(event: HubSpotWebhookEvent): boolean {
  const isCreation =
    event.objectId !== undefined &&
    event.objectTypeId === "0-3" &&
    (event.subscriptionType === "object.creation" ||
      event.subscriptionType === "deal.creation");
  const isContactAssociationAdded =
    (event.subscriptionType === "object.associationChange" ||
      event.subscriptionType === "deal.associationChange") &&
    event.associationRemoved === false &&
    event.associationType === "DEAL_TO_CONTACT" &&
    (event.fromObjectTypeId === undefined || event.fromObjectTypeId === "0-3") &&
    (event.toObjectTypeId === undefined || event.toObjectTypeId === "0-1") &&
    event.fromObjectId !== undefined;

  return isCreation || isContactAssociationAdded;
}

function getDealId(event: HubSpotWebhookEvent): string | null {
  const value =
    event.subscriptionType === "object.associationChange" ||
    event.subscriptionType === "deal.associationChange"
      ? event.fromObjectId
      : event.objectId;

  return value === undefined ? null : String(value);
}
