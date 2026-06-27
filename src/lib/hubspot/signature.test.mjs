import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { getHubSpotRequestUri, verifyHubSpotV3Signature } from "./signature.ts";

const clientSecret = "test-client-secret";
const method = "POST";
const uri = "https://porch-integrations.vercel.app/api/hubspot/webhook";
const rawBody = '[{"objectId":123,"propertyValue":"confirmed"}]';
const timestamp = "1782560000000";
const signature = createHmac("sha256", clientSecret)
  .update(`${method}${uri}${rawBody}${timestamp}`, "utf8")
  .digest("base64");

test("verifies a current HubSpot v3 signature", () => {
  assert.deepEqual(
    verifyHubSpotV3Signature({
      clientSecret,
      method,
      uri,
      rawBody,
      signature,
      timestamp,
      now: Number(timestamp) + 1000,
    }),
    { ok: true },
  );
});

test("rejects invalid and expired HubSpot signatures", () => {
  assert.deepEqual(
    verifyHubSpotV3Signature({
      clientSecret,
      method,
      uri,
      rawBody,
      signature: "invalid",
      timestamp,
      now: Number(timestamp),
    }),
    { ok: false, reason: "invalid_signature" },
  );

  assert.deepEqual(
    verifyHubSpotV3Signature({
      clientSecret,
      method,
      uri,
      rawBody,
      signature,
      timestamp,
      now: Number(timestamp) + 5 * 60 * 1000 + 1,
    }),
    { ok: false, reason: "expired_timestamp" },
  );
});

test("uses the forwarded public URL when Vercel provides proxy headers", () => {
  const request = new Request("https://internal.vercel.app/api/hubspot/webhook?source=test", {
    headers: {
      host: "internal.vercel.app",
      "x-forwarded-host": "porch-integrations.vercel.app",
      "x-forwarded-proto": "https",
    },
  });

  assert.equal(
    getHubSpotRequestUri(request),
    "https://porch-integrations.vercel.app/api/hubspot/webhook?source=test",
  );
});
