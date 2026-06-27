import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const URI_DECODE_PATTERN = /%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi;
const URI_DECODE_VALUES: Record<string, string> = {
  "%3A": ":",
  "%2F": "/",
  "%3F": "?",
  "%40": "@",
  "%21": "!",
  "%24": "$",
  "%27": "'",
  "%28": "(",
  "%29": ")",
  "%2A": "*",
  "%2C": ",",
  "%3B": ";",
};

export type HubSpotSignatureVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_config"
        | "missing_signature"
        | "invalid_timestamp"
        | "expired_timestamp"
        | "invalid_signature";
    };

type VerifyHubSpotSignatureInput = {
  clientSecret?: string;
  method: string;
  uri: string;
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
};

export function verifyHubSpotV3Signature(
  input: VerifyHubSpotSignatureInput,
): HubSpotSignatureVerification {
  if (!input.clientSecret) {
    return { ok: false, reason: "missing_config" };
  }

  if (!input.signature || !input.timestamp) {
    return { ok: false, reason: "missing_signature" };
  }

  const timestamp = Number(input.timestamp);

  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  if (Math.abs((input.now ?? Date.now()) - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, reason: "expired_timestamp" };
  }

  const source = `${input.method.toUpperCase()}${decodeHubSpotSignatureUri(input.uri)}${input.rawBody}${input.timestamp}`;
  const expectedSignature = createHmac("sha256", input.clientSecret)
    .update(source, "utf8")
    .digest("base64");

  return secureEqual(expectedSignature, input.signature)
    ? { ok: true }
    : { ok: false, reason: "invalid_signature" };
}

export function getHubSpotRequestUri(request: Request): string {
  const requestUrl = new URL(request.url);
  const forwardedProtocol = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"));
  const host = forwardedHost ?? request.headers.get("host") ?? requestUrl.host;
  const protocol = forwardedProtocol ?? requestUrl.protocol.replace(":", "");

  return `${protocol}://${host}${requestUrl.pathname}${requestUrl.search}`;
}

function decodeHubSpotSignatureUri(uri: string): string {
  return uri.replace(URI_DECODE_PATTERN, (encoded) => URI_DECODE_VALUES[encoded.toUpperCase()]);
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
  );
}
