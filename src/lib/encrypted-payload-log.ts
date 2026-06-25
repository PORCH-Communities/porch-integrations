import { createCipheriv, randomBytes, publicEncrypt } from "node:crypto";

type EncryptedPayloadLog =
  | {
      ok: true;
      alg: "RSA-OAEP-SHA256+A256GCM";
      encryptedKey: string;
      iv: string;
      authTag: string;
      ciphertext: string;
    }
  | {
      ok: false;
      reason: "disabled" | "missing_public_key" | "encryption_failed";
    };

export function encryptPayloadForLog(rawBody: string): EncryptedPayloadLog {
  if (process.env.ENABLE_ENCRYPTED_GIVEBUTTER_PAYLOAD_LOG !== "true") {
    return { ok: false, reason: "disabled" };
  }

  const publicKey = process.env.GIVEBUTTER_PAYLOAD_LOG_PUBLIC_KEY;

  if (!publicKey) {
    return { ok: false, reason: "missing_public_key" };
  }

  try {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(rawBody, "utf8"), cipher.final()]);
    const encryptedKey = publicEncrypt(
      {
        key: normalizePublicKey(publicKey),
        oaepHash: "sha256",
      },
      key,
    );

    return {
      ok: true,
      alg: "RSA-OAEP-SHA256+A256GCM",
      encryptedKey: encryptedKey.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } catch {
    return { ok: false, reason: "encryption_failed" };
  }
}

function normalizePublicKey(publicKey: string): string {
  return publicKey.replace(/\\n/g, "\n");
}
