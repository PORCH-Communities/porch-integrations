import { createDecipheriv, privateDecrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { get } from "@vercel/blob";

const [blobUrlOrPathname, privateKeyPath] = process.argv.slice(2);

if (!blobUrlOrPathname || !privateKeyPath) {
  console.error("Usage: node scripts/decrypt-givebutter-blob.mjs <blob-url-or-pathname> <private-key.pem>");
  process.exit(1);
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN must be set locally to read private Vercel Blob objects.");
  process.exit(1);
}

const blob = await get(blobUrlOrPathname);
const encryptedLog = await blob.text();
const log = JSON.parse(encryptedLog);
const encryptedPayload = log.encryptedPayload;

if (encryptedPayload?.alg !== "RSA-OAEP-SHA256+A256GCM") {
  console.error("Unsupported or missing encrypted payload format.");
  process.exit(1);
}

const privateKey = readFileSync(privateKeyPath, "utf8");
const key = privateDecrypt(
  {
    key: privateKey,
    oaepHash: "sha256",
  },
  Buffer.from(encryptedPayload.encryptedKey, "base64"),
);

const decipher = createDecipheriv(
  "aes-256-gcm",
  key,
  Buffer.from(encryptedPayload.iv, "base64"),
);

decipher.setAuthTag(Buffer.from(encryptedPayload.authTag, "base64"));

const plaintext = Buffer.concat([
  decipher.update(Buffer.from(encryptedPayload.ciphertext, "base64")),
  decipher.final(),
]).toString("utf8");

console.log(JSON.stringify(JSON.parse(plaintext), null, 2));
