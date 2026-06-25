import { get } from "@vercel/blob";

const target = process.argv[2];

if (!target) {
  console.error("Usage: node scripts/read-givebutter-blob.mjs <blob-url-or-pathname>");
  process.exit(1);
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN must be set locally to read private Vercel Blob objects.");
  process.exit(1);
}

const blob = await get(target);
const text = await blob.text();

try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
