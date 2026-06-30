/**
 * One-shot script: creates the two recurring gift properties on HubSpot Deal objects.
 *
 * Run once per portal before deploying recurring transaction handling:
 *   node --env-file=.env scripts/create-recurring-hubspot-properties.mjs
 *
 * Safe to re-run: existing properties are skipped, not overwritten.
 */

const HUBSPOT_API_BASE = "https://api.hubapi.com";

const DEAL_PROPERTIES = [
  {
    name: "givebutter_plan_id",
    label: "Givebutter Plan ID",
    type: "string",
    fieldType: "text",
    groupName: "dealinformation",
    description:
      "Stable recurring plan identifier from Givebutter. The same value appears on every installment of the same recurring series. Primary grouping key for recurring gifts — never changes across installments.",
  },
  {
    name: "givebutter_is_recurring",
    label: "Givebutter Is Recurring",
    type: "enumeration",
    fieldType: "booleancheckbox",
    groupName: "dealinformation",
    description:
      "True when this deal represents a recurring gift installment from Givebutter. Use as a workflow filter to suppress thank-you email triggers on recurring charges.",
    options: [
      { label: "Yes", value: "true", displayOrder: 0, hidden: false },
      { label: "No", value: "false", displayOrder: 1, hidden: false },
    ],
  },
];

const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

if (!token) {
  console.error("Missing required environment variable: HUBSPOT_PRIVATE_APP_TOKEN");
  process.exit(1);
}

const results = await Promise.all(DEAL_PROPERTIES.map(createProperty));
const created = results.filter((r) => r.status === "created").length;
const skipped = results.filter((r) => r.status === "skipped").length;
const failed = results.filter((r) => r.status === "failed").length;

console.log(JSON.stringify({ created, skipped, failed, results }, null, 2));

if (failed > 0) {
  process.exit(1);
}

async function createProperty(property) {
  const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/properties/deals`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(property),
  });

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
