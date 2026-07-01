import { readFile } from "node:fs/promises";

import { mapGivebutterRefund } from "../src/lib/givebutter/refund-payload.ts";
import { createHubSpotClient } from "../src/lib/hubspot/client.ts";
import { processGivebutterRefund } from "../src/lib/hubspot/refund-reconciliation.ts";

const path = process.argv[2];

if (!path) {
  console.error("Usage: node --experimental-strip-types --env-file=.env scripts/replay-refund.mjs <captured-payload.json>");
  process.exit(1);
}

const stored = JSON.parse(await readFile(path, "utf8"));
const payload = stored.payload ?? stored;
const refund = mapGivebutterRefund(payload);
const result = await processGivebutterRefund(createHubSpotClient(), refund);

console.log(JSON.stringify({ refund, result }, null, 2));
