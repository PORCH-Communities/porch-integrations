import { list } from "@vercel/blob";

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN must be set locally to list private Vercel Blob objects.");
  process.exit(1);
}

const prefix = process.argv[2] ?? "givebutter-payload-logs/";
let cursor;

do {
  const page = await list({ prefix, cursor });

  for (const blob of page.blobs) {
    console.log([blob.pathname, blob.uploadedAt, blob.size, blob.url].join("\t"));
  }

  cursor = page.cursor;
} while (cursor);
