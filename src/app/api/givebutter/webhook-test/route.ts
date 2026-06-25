import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;

type PayloadSummary = {
  event: string | null;
  objectType: string | null;
  objectId: string | number | null;
  transactionId: string | number | null;
  campaignId: string | number | null;
  contactId: string | number | null;
  topLevelKeys: string[];
};

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/givebutter/webhook-test",
    usage: "POST a Givebutter webhook payload here to log and summarize it.",
  });
}

export async function POST(request: NextRequest) {
  const receivedAt = new Date().toISOString();
  const rawBody = await request.text();
  const payload = parseJson(rawBody);
  const summary = summarizePayload(payload);
  const givebutterHeaders = getGivebutterHeaders(request);

  console.log(
    JSON.stringify(
      {
        source: "givebutter-webhook-test",
        receivedAt,
        givebutterHeaders,
        summary,
        rawBody,
        payload,
      },
      null,
      2,
    ),
  );

  return NextResponse.json({
    ok: true,
    receivedAt,
    summary,
    givebutterHeaders,
    rawBodyBytes: Buffer.byteLength(rawBody, "utf8"),
  });
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function summarizePayload(payload: unknown): PayloadSummary {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? asRecord(root?.object) ?? root;
  const transaction = asRecord(root?.transaction) ?? asRecord(data?.transaction);
  const campaign = asRecord(root?.campaign) ?? asRecord(data?.campaign);
  const contact = asRecord(root?.contact) ?? asRecord(data?.contact);
  const event = firstString(root?.event, root?.type, root?.event_type, root?.eventName);
  const objectId = firstId(data?.id, root?.id);

  return {
    event,
    objectType: firstString(root?.object, root?.object_type, data?.object, data?.type),
    objectId,
    transactionId: firstId(
      root?.transaction_id,
      transaction?.id,
      data?.transaction_id,
      event?.startsWith("transaction.") ? data?.id : null,
      event?.startsWith("transaction.") ? objectId : null,
    ),
    campaignId: firstId(
      root?.campaign_id,
      campaign?.id,
      data?.campaign_id,
      event?.startsWith("campaign.") ? objectId : null,
    ),
    contactId: firstId(
      root?.contact_id,
      contact?.id,
      data?.contact_id,
      event?.startsWith("contact.") ? objectId : null,
    ),
    topLevelKeys: root ? Object.keys(root).sort() : [],
  };
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

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function firstId(...values: unknown[]): string | number | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }

    if (typeof value === "number") {
      return value;
    }
  }

  return null;
}
