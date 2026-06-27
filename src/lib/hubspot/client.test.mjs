import assert from "node:assert/strict";
import test from "node:test";

import { createHubSpotClient } from "./client.ts";

test("retries a rate-limited HubSpot search using Retry-After", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push([url, init]);

    if (requests.length === 1) {
      return new Response('{"status":"error","message":"rate limited"}', {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }

    return Response.json({
      results: [{ id: "contact-1", properties: { email: "donor@example.org" } }],
    });
  };
  const client = createHubSpotClient({ accessToken: "test-token", fetchImpl });

  const results = await client.searchContacts("email", "donor@example.org", ["email"]);

  assert.equal(requests.length, 2);
  assert.equal(results[0].id, "contact-1");
  assert.equal(requests[0][1].method, "POST");
});
