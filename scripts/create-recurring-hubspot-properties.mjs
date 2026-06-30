/**
 * One-shot script: creates the recurring gift properties on HubSpot Deal objects.
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
  {
    name: "recurring_communication_type",
    label: "Recurring Communication Type",
    type: "enumeration",
    fieldType: "select",
    groupName: "dealinformation",
    description:
      "Routes recurring gift communications. Initial installments use the standard thank-you workflow, anniversaries use the anniversary workflow, and suppressed installments send neither.",
    options: [
      { label: "Initial", value: "initial", displayOrder: 0, hidden: false },
      { label: "Anniversary", value: "anniversary", displayOrder: 1, hidden: false },
      { label: "Suppressed", value: "suppressed", displayOrder: 2, hidden: false },
    ],
  },
  {
    name: "recurring_anniversary_number",
    label: "Recurring Anniversary Number",
    type: "number",
    fieldType: "number",
    groupName: "dealinformation",
    description:
      "Calendar anniversary number for an anniversary-eligible installment (1 for the first anniversary, 2 for the second, and so on). Blank for other installments.",
  },
  {
    name: "recurring_plan_start_date",
    label: "Recurring Plan Start Date",
    type: "date",
    fieldType: "date",
    groupName: "dealinformation",
    description:
      "Date of the first successful installment in the Givebutter recurring plan. Used to determine anniversary communication eligibility.",
  },
];

const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

if (!token) {
  console.error("Missing required environment variable: HUBSPOT_PRIVATE_APP_TOKEN");
  process.exit(1);
}

const results = [];

// HubSpot can serialize schema mutations internally, so create properties one
// at a time instead of issuing concurrent POST requests that may stall.
for (const property of DEAL_PROPERTIES) {
  results.push(await createProperty(property));
}
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
    signal: AbortSignal.timeout(15_000),
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
