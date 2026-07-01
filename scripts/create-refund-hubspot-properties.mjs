/**
 * One-shot script: creates refund metadata properties on HubSpot Deal objects.
 *
 * Run once per portal before deploying refund reconciliation:
 *   node --env-file=.env scripts/create-refund-hubspot-properties.mjs
 *
 * Safe to re-run: existing properties are skipped, not overwritten.
 */

const HUBSPOT_API_BASE = "https://api.hubapi.com";

const DEAL_PROPERTIES = [
  {
    name: "gb_refunded_amount",
    label: "Givebutter Refunded Amount",
    type: "number",
    fieldType: "number",
    groupName: "dealinformation",
    description: "Total amount refunded against this donation (supports partial and multiple refunds). Does not overwrite the original gross gift amount.",
  },
  {
    name: "gb_refund_date",
    label: "Givebutter Refund Date",
    type: "datetime",
    fieldType: "date",
    groupName: "dealinformation",
    description: "Date of the most recent refund event from Givebutter.",
  },
  {
    name: "gb_refund_reason",
    label: "Givebutter Refund Reason",
    type: "string",
    fieldType: "text",
    groupName: "dealinformation",
    description: "Reason string provided by Givebutter for the refund.",
  },
  {
    name: "gb_refund_status",
    label: "Givebutter Refund Status",
    type: "string",
    fieldType: "text",
    groupName: "dealinformation",
    description: "Status of the refund as reported by Givebutter (e.g. succeeded, pending).",
  },
  {
    name: "gb_net_donation_amount",
    label: "Givebutter Net Donation Amount",
    type: "number",
    fieldType: "number",
    groupName: "dealinformation",
    description: "Gross donation amount minus all refunds to date. Written by Vercel on each refund.created event.",
  },
  {
    name: "gb_processed_refund_ids",
    label: "Givebutter Processed Refund IDs",
    type: "string",
    fieldType: "textarea",
    groupName: "dealinformation",
    description: "Comma-separated Givebutter refund IDs already applied to this deal. Used by Vercel for webhook idempotency.",
  },
];

const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

if (!token) {
  console.error("Missing required environment variable: HUBSPOT_PRIVATE_APP_TOKEN");
  process.exit(1);
}

const results = [];

for (const property of DEAL_PROPERTIES) {
  try {
    results.push(await createProperty(property));
  } catch (error) {
    results.push({
      name: property.name,
      status: "failed",
      reason: error instanceof Error ? error.message : "unknown_error",
    });
  }
}
const created = results.filter((r) => r.status === "created").length;
const skipped = results.filter((r) => r.status === "skipped").length;
const failed = results.filter((r) => r.status === "failed").length;

console.log(JSON.stringify({ created, skipped, failed, results }, null, 2));

if (failed > 0) {
  process.exit(1);
}

async function createProperty(property) {
  const response = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/properties/deals`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(property),
    },
  );

  if (response.ok) {
    const body = await response.json();
    return { name: property.name, status: "created", id: body.name };
  }

  if (response.status === 409) {
    return { name: property.name, status: "skipped", reason: "already_exists" };
  }

  const body = (await response.text()).slice(0, 500);
  return { name: property.name, status: "failed", httpStatus: response.status, body };
}
