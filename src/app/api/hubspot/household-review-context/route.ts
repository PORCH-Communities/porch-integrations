import { NextResponse } from "next/server";

import { createHubSpotClient, HubSpotApiError } from "@/lib/hubspot/client";
import { getHubSpotRequestUri, verifyHubSpotV3Signature } from "@/lib/hubspot/signature";

export const runtime = "nodejs";

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

  let body: { contactId?: unknown } | null = null;
  try { body = JSON.parse(rawBody); } catch { /* handled below */ }
  const contactId = typeof body?.contactId === "string" ? body.contactId.trim() : "";
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "contactId is required." }, { status: 400 });
  }

  try {
    const client = createHubSpotClient();
    const contact = await client.getContact(contactId);
    const companyIds = contact.associations?.companies?.results?.map(({ id }) => id) ?? [];
    const companies = await Promise.all(companyIds.map((id) => client.getCompany(id)));
    const householdCompanies = companies.filter(
      (company) => company.properties.record_type === "household",
    );
    const households = await Promise.all(
      householdCompanies.map(async (company) => {
        const associations = await client.getCompanyContactAssociations(company.id);
        const memberIds = associations
          .map(({ toObjectId }) => String(toObjectId))
          .filter((id) => id !== contactId)
          .slice(0, 25);
        const members = await Promise.all(memberIds.map((id) => client.getContact(id)));
        return {
          id: company.id,
          name: company.properties.name || `Household ${company.id}`,
          members: members.map((member) => ({
            id: member.id,
            name:
              [member.properties.firstname, member.properties.lastname].filter(Boolean).join(" ") ||
              member.properties.email ||
              `Contact ${member.id}`,
          })),
        };
      }),
    );
    return NextResponse.json({ ok: true, households });
  } catch (error) {
    const retryable = error instanceof HubSpotApiError ? error.retryable : true;
    return NextResponse.json(
      { ok: false, error: "Unable to load Household context.", retryable },
      { status: retryable ? 503 : 500 },
    );
  }
}
