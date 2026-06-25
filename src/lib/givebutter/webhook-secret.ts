import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEADERS = [
  "x-givebutter-signature",
  "givebutter-signature",
  "x-givebutter-webhook-signature",
];

const SECRET_HEADERS = [
  "x-givebutter-webhook-secret",
  "givebutter-webhook-secret",
];

export type GivebutterWebhookVerification =
  | { ok: true; method: "hmac" | "shared_secret" }
  | { ok: false; reason: "missing_config" | "missing_signature" | "invalid_signature" };

export function verifyGivebutterWebhookSecret(
  headers: Headers,
  rawBody: string,
): GivebutterWebhookVerification {
  const configuredSecret = process.env.GIVEBUTTER_WEBHOOK_SECRET;

  if (!configuredSecret) {
    return { ok: false, reason: "missing_config" };
  }

  for (const headerName of SECRET_HEADERS) {
    const providedSecret = headers.get(headerName);

    if (providedSecret && secureEqual(providedSecret, configuredSecret)) {
      return { ok: true, method: "shared_secret" };
    }
  }

  const signatures = SIGNATURE_HEADERS.flatMap((headerName) =>
    extractSignatureValues(headers.get(headerName)),
  );

  if (signatures.length === 0) {
    return { ok: false, reason: "missing_signature" };
  }

  const expectedSignatures = [
    hmac(rawBody, configuredSecret, "sha256", "hex"),
    `sha256=${hmac(rawBody, configuredSecret, "sha256", "hex")}`,
    hmac(rawBody, configuredSecret, "sha256", "base64"),
    hmac(rawBody, configuredSecret, "sha1", "hex"),
    `sha1=${hmac(rawBody, configuredSecret, "sha1", "hex")}`,
  ];

  const matchesSignature = signatures.some((signature) =>
    expectedSignatures.some((expected) => secureEqual(signature, expected)),
  );

  if (!matchesSignature) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true, method: "hmac" };
}

function extractSignatureValues(headerValue: string | null): string[] {
  if (!headerValue) {
    return [];
  }

  return headerValue
    .split(",")
    .map((part) => part.trim())
    .flatMap((part) => {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex === -1 || part.startsWith("sha")) {
        return [part];
      }

      const key = part.slice(0, separatorIndex);
      const value = part.slice(separatorIndex + 1);

      return key === "v1" || key === "signature" ? [value] : [];
    })
    .filter(Boolean);
}

function hmac(
  rawBody: string,
  secret: string,
  algorithm: "sha1" | "sha256",
  encoding: "base64" | "hex",
): string {
  return createHmac(algorithm, secret).update(rawBody, "utf8").digest(encoding);
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
