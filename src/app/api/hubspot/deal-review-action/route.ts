import { NextResponse } from "next/server";

import { createHubSpotClient, HubSpotApiError } from "@/lib/hubspot/client";
import {
  processDealReviewAction,
  type DealReviewAction,
} from "@/lib/hubspot/deal-confirmation";
import { getHubSpotRequestUri, verifyHubSpotV3Signature } from "@/lib/hubspot/signature";

export const runtime = "nodejs";

const ACTIONS = new Set<DealReviewAction>([
  "match_candidate",
  "create_new_deal",
]);

export async function POST(request: Request) {
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
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const body = parseRequestBody(rawBody) as {
    dealId?: unknown;
    action?: unknown;
  } | null;
  const dealId = typeof body?.dealId === "string" ? body.dealId.trim() : "";
  const action = body?.action;

  if (!dealId || typeof action !== "string" || !ACTIONS.has(action as DealReviewAction)) {
    return NextResponse.json(
      { ok: false, error: "dealId and a valid action are required." },
      { status: 400 },
    );
  }

  try {
    const result = await processDealReviewAction(
      createHubSpotClient(),
      dealId,
      action as DealReviewAction,
    );

    console.log(JSON.stringify({ source: "deal-review-action", dealId, action, result }));

    const ok = result.status === "confirmed" || result.status === "rejected";
    return NextResponse.json({ ok, result }, { status: ok ? 200 : 409 });
  } catch (error) {
    const retryable = error instanceof HubSpotApiError ? error.retryable : true;

    console.error(
      JSON.stringify({
        source: "deal-review-action",
        dealId,
        action,
        failed: true,
        retryable,
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );

    return NextResponse.json(
      { ok: false, error: "Deal review action failed.", retryable },
      { status: retryable ? 503 : 500 },
    );
  }
}

function parseRequestBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
