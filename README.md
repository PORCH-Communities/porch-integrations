This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Givebutter Transaction Samples

Use the Givebutter API to fetch recent transaction samples and wrap each one in the webhook envelope expected by `/api/givebutter/webhook-test`:

```bash
npm run givebutter:sample-transactions -- --limit 3
```

The command uses `GIVEBUTTER_API_KEY` from `.env` and redacts donor contact details by default. To inspect the exact raw API payload, run:

```bash
npm run givebutter:sample-transactions -- --limit 1 --raw
```

Other raw-data sources that are useful for validation:

- Enable `ENABLE_PERSISTED_GIVEBUTTER_PAYLOAD_LOG=true` and `BLOB_READ_WRITE_TOKEN` to persist real incoming webhook payloads.
- List saved webhook payloads with `node --env-file=.env scripts/list-givebutter-blobs.mjs`.
- Read one saved payload with `node --env-file=.env scripts/read-givebutter-blob.mjs <blob-url-or-pathname>`.
- Temporarily enable `ENABLE_GIVEBUTTER_WEBHOOK_TEST=true` and post a sampled `samples[0]` payload to `/api/givebutter/webhook-test` to validate the summary mapper without hitting the production webhook secret check.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
