const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.GIVEBUTTER_API_KEY;

if (!apiKey) {
  console.error("GIVEBUTTER_API_KEY must be set locally to sample transactions.");
  process.exit(1);
}

const limit = clampLimit(args.limit ?? 3);
const url = new URL("https://api.givebutter.com/v1/transactions");
url.searchParams.set("limit", String(limit));

const response = await fetch(url, {
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
});

const text = await response.text();

if (!response.ok) {
  console.error(`Givebutter API request failed with ${response.status}:`);
  console.error(text);
  process.exit(1);
}

const body = JSON.parse(text);
const transactions = Array.isArray(body.data) ? body.data : [];
const redact = !args.raw;

const output = {
  source: "givebutter-api",
  endpoint: "/v1/transactions",
  fetchedAt: new Date().toISOString(),
  redacted: redact,
  count: transactions.length,
  samples: transactions.map((transaction) => ({
    id: `api-sample-${transaction.id ?? transaction.number ?? crypto.randomUUID()}`,
    event: "transaction.succeeded",
    data: redact ? redactTransaction(transaction) : transaction,
  })),
};

console.log(JSON.stringify(output, null, 2));

function parseArgs(argv) {
  const parsed = {
    limit: undefined,
    raw: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--raw") {
      parsed.raw = true;
      continue;
    }

    if (arg === "--limit") {
      parsed.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      parsed.limit = Number(arg.slice("--limit=".length));
      continue;
    }

    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }

  return parsed;
}

function clampLimit(value) {
  if (!Number.isInteger(value) || value < 1) {
    return 3;
  }

  return Math.min(value, 25);
}

function redactTransaction(transaction) {
  return redactValue(transaction, []);
}

function redactValue(value, path) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, path));
  }

  if (!value || typeof value !== "object") {
    return redactScalar(value, path);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, redactValue(nestedValue, [...path, key])]),
  );
}

function redactScalar(value, path) {
  const key = path.at(-1);
  const joinedPath = path.join(".");

  if (typeof value !== "string" && typeof value !== "number") {
    return value;
  }

  if (key === "email" || key === "recipient_email") {
    return "donor@example.org";
  }

  if (key === "phone") {
    return "+15555550123";
  }

  if (key === "first_name") {
    return "Sample";
  }

  if (key === "last_name") {
    return "Donor";
  }

  if (key === "company_name" || key === "company") {
    return typeof value === "number" ? value : "Sample Organization";
  }

  if (key === "address_1") {
    return "123 Sample St";
  }

  if (key === "address") {
    return "123 Sample St";
  }

  if (key === "address_2") {
    return value ? "Apt 1" : value;
  }

  if (key === "city") {
    return "Sampletown";
  }

  if (key === "zipcode") {
    return "27516";
  }

  if (joinedPath === "giving_space.name" || key === "recipient_name" || key === "name") {
    return "Sample Donor";
  }

  if (key === "recipient") {
    return "Sample Recipient";
  }

  if (key === "message" || key === "note" || key === "internal_note") {
    return "[redacted]";
  }

  if (path[0] === "custom_fields" && key === "value") {
    return "[redacted]";
  }

  if (joinedPath.startsWith("attribution_data")) {
    return typeof value === "number" ? 0 : "redacted";
  }

  return value;
}
