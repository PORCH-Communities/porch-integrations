import { NextRequest, NextResponse } from "next/server";

import { verifyZapierSecret } from "@/lib/webhooks";

type SyncHouseholdRequest = {
  hubspotCompanyId: string;
  hubspotContactId: string;
  givebutterHouseholdId?: string | number | null;
  givebutterContactId: string | number;
  householdName: string;
  envelopeName?: string | null;
  headContactId?: string | number | null;
};

export async function POST(request: NextRequest) {
  if (!verifyZapierSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as Partial<SyncHouseholdRequest>;
  const missingFields = getMissingFields(body);

  if (missingFields.length > 0) {
    return NextResponse.json(
      { error: "Missing required fields.", missingFields },
      { status: 400 },
    );
  }

  return NextResponse.json({
    success: false,
    mode: "stub",
    message: "Givebutter and HubSpot write calls are not wired yet.",
    received: {
      hubspotCompanyId: body.hubspotCompanyId,
      hubspotContactId: body.hubspotContactId,
      givebutterHouseholdId: body.givebutterHouseholdId ?? null,
      givebutterContactId: body.givebutterContactId,
      householdName: body.householdName,
      envelopeName: body.envelopeName ?? null,
      headContactId: body.headContactId ?? null,
    },
  });
}

function getMissingFields(body: Partial<SyncHouseholdRequest>): string[] {
  return [
    "hubspotCompanyId",
    "hubspotContactId",
    "givebutterContactId",
    "householdName",
  ].filter((field) => !body[field as keyof SyncHouseholdRequest]);
}
