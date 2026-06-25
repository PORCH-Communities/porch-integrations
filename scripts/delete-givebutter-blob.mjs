import { del } from "@vercel/blob";

const target = process.argv[2];

if (!target) {
  console.error("Usage: node scripts/delete-givebutter-blob.mjs <blob-url-or-pathname>");
  process.exit(1);
}

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN must be set locally to delete private Vercel Blob objects.");
  process.exit(1);
}

await del(target);
console.log(`Deleted ${target}`);
