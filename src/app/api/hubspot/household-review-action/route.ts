import { NextResponse } from "next/server";

import { createHubSpotClient, HubSpotApiError } from "@/lib/hubspot/client";
import {
  processHouseholdReviewAction,
  type HouseholdReviewAction,
} from "@/lib/hubspot/household-confirmation";
import { getHubSpotRequestUri, verifyHubSpotV3Signature } from "@/lib/hubspot/signature";

export const runtime = "nodejs";

const ACTIONS = new Set<HouseholdReviewAction>([
  "match_existing_household",
  "save_new_household",
  "no_household",
  "confirm_household",
  "delete_household",
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

  let body: { contactId?: unknown; action?: unknown; companyId?: unknown } | null = null;
  try { body = JSON.parse(rawBody); } catch { /* handled below */ }
  const contactId = typeof body?.contactId === "string" ? body.contactId.trim() : "";
  const action = body?.action;
  const companyId = typeof body?.companyId === "string" ? body.companyId.trim() : undefined;
  if (!contactId || typeof action !== "string" || !ACTIONS.has(action as HouseholdReviewAction)) {
    return NextResponse.json({ ok: false, error: "contactId and a valid action are required." }, { status: 400 });
  }

  try {
    const result = await processHouseholdReviewAction(
      createHubSpotClient(), contactId, action as HouseholdReviewAction, companyId,
    );
    const ok = result.status === "associated" || result.status === "review_fields_cleared";
    console.log(JSON.stringify({ source: "household-review-action", contactId, action, result }));
    return NextResponse.json({ ok, result }, { status: ok ? 200 : 409 });
  } catch (error) {
    const retryable = error instanceof HubSpotApiError ? error.retryable : true;
    console.error(JSON.stringify({ source: "household-review-action", contactId, action, failed: true, retryable, message: error instanceof Error ? error.message : "Unknown error" }));
    return NextResponse.json({ ok: false, error: "Household review action failed.", retryable }, { status: retryable ? 503 : 500 });
  }
}
