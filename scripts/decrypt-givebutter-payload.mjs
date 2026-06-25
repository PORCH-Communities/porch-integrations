import { createDecipheriv, privateDecrypt } from "node:crypto";
import { readFileSync } from "node:fs";

const [logPath, privateKeyPath] = process.argv.slice(2);

if (!logPath || !privateKeyPath) {
  console.error("Usage: node scripts/decrypt-givebutter-payload.mjs <log-json-file> <private-key.pem>");
  process.exit(1);
}

const log = JSON.parse(readFileSync(logPath, "utf8"));
const encryptedPayload = log.encryptedPayload ?? log;

if (encryptedPayload.alg !== "RSA-OAEP-SHA256+A256GCM") {
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
