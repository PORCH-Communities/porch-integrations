import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { verifyGivebutterWebhookSecret } from "./webhook-secret.ts";

const rawBody = '{"event":"transaction.succeeded","data":{"id":"transaction-1"}}';

test("accepts Givebutter's Signature header as the configured shared secret", () => {
  withWebhookSecret("test-signing-secret", () => {
    const headers = new Headers({ Signature: "test-signing-secret" });

    assert.deepEqual(verifyGivebutterWebhookSecret(headers, rawBody), {
      ok: true,
      method: "shared_secret",
    });
  });
});

test("rejects an invalid Givebutter Signature header", () => {
  withWebhookSecret("test-signing-secret", () => {
    const headers = new Headers({ Signature: "wrong-signing-secret" });

    assert.deepEqual(verifyGivebutterWebhookSecret(headers, rawBody), {
      ok: false,
      reason: "invalid_signature",
    });
  });
});

test("preserves HMAC verification for legacy Givebutter signature headers", () => {
  withWebhookSecret("test-signing-secret", () => {
    const signature = createHmac("sha256", "test-signing-secret")
      .update(rawBody, "utf8")
      .digest("hex");
    const headers = new Headers({ "X-Givebutter-Signature": signature });

    assert.deepEqual(verifyGivebutterWebhookSecret(headers, rawBody), {
      ok: true,
      method: "hmac",
    });
  });
});

test("distinguishes missing configuration from a missing signature", () => {
  withWebhookSecret(undefined, () => {
    assert.deepEqual(verifyGivebutterWebhookSecret(new Headers(), rawBody), {
      ok: false,
      reason: "missing_config",
    });
  });

  withWebhookSecret("test-signing-secret", () => {
    assert.deepEqual(verifyGivebutterWebhookSecret(new Headers(), rawBody), {
      ok: false,
      reason: "missing_signature",
    });
  });
});

function withWebhookSecret(secret, callback) {
  const previousSecret = process.env.GIVEBUTTER_WEBHOOK_SECRET;

  if (secret === undefined) {
    delete process.env.GIVEBUTTER_WEBHOOK_SECRET;
  } else {
    process.env.GIVEBUTTER_WEBHOOK_SECRET = secret;
  }

  try {
    callback();
  } finally {
    if (previousSecret === undefined) {
      delete process.env.GIVEBUTTER_WEBHOOK_SECRET;
    } else {
      process.env.GIVEBUTTER_WEBHOOK_SECRET = previousSecret;
    }
  }
}
