import assert from "node:assert/strict";
import test from "node:test";

import {
  DEAL_MATCH_PIPELINES,
  scoreDealCandidate,
  findBestDealMatch,
  findDealCandidates,
} from "./deal-matching.ts";

// ─── scoreDealCandidate ───────────────────────────────────────────────────────

test("scores contact association at +40", () => {
  const result = scoreDealCandidate(
    makeDonation({ companyName: null }),
    makeCandidate({ contactAssociated: true, companyMatched: false, amount: null }),
  );

  assert.equal(result.score, 40);
  assert.ok(result.signals.includes("contact_association"));
  assert.equal(result.decision, "needs_review");
});

test("scores amount match at +50", () => {
  const result = scoreDealCandidate(
    makeDonation({ amount: 500 }),
    makeCandidate({ amount: "500", contactAssociated: false }),
  );

  assert.equal(result.score, 50);
  assert.ok(result.signals.includes("amount"));
  assert.equal(result.decision, "needs_review");
});

test("amount match accepts values within 1% tolerance", () => {
  const result = scoreDealCandidate(
    makeDonation({ amount: 100 }),
    makeCandidate({ amount: "100.50", contactAssociated: false }),
  );

  assert.equal(result.score, 50);
  assert.ok(result.signals.includes("amount"));
});

test("amount match rejects values outside 1% tolerance", () => {
  const result = scoreDealCandidate(
    makeDonation({ amount: 100 }),
    makeCandidate({ amount: "105", contactAssociated: false }),
  );

  assert.equal(result.score, 0);
  assert.ok(!result.signals.includes("amount"));
});

test("scores company match at +30", () => {
  const result = scoreDealCandidate(
    makeDonation({ companyName: "Acme Corp" }),
    makeCandidate({ companyMatched: true, contactAssociated: false, amount: null }),
  );

  assert.equal(result.score, 30);
  assert.ok(result.signals.includes("company_match"));
  assert.equal(result.decision, "no_match");
});

test("all three signals fire for auto_close", () => {
  const result = scoreDealCandidate(
    makeDonation({ amount: 1000, companyName: "Acme Corp" }),
    makeCandidate({ contactAssociated: true, amount: "1000", companyMatched: true }),
  );

  assert.equal(result.score, 120);
  assert.equal(result.decision, "auto_close");
  assert.deepEqual(result.signals, ["contact_association", "amount", "company_match"]);
});

test("contact + amount yields auto_close at 90", () => {
  const result = scoreDealCandidate(
    makeDonation({ amount: 250, companyName: null }),
    makeCandidate({ contactAssociated: true, amount: "250", companyMatched: false }),
  );

  assert.equal(result.score, 90);
  assert.equal(result.decision, "auto_close");
});

test("contact only (40) yields needs_review", () => {
  const result = scoreDealCandidate(
    makeDonation({ amount: 250, companyName: null }),
    makeCandidate({ contactAssociated: true, amount: "999", companyMatched: false }),
  );

  assert.equal(result.score, 40);
  assert.equal(result.decision, "needs_review");
});

test("no signals yields no_match", () => {
  const result = scoreDealCandidate(
    makeDonation({ amount: 100, companyName: null }),
    makeCandidate({ contactAssociated: false, amount: "999", companyMatched: false }),
  );

  assert.equal(result.score, 0);
  assert.equal(result.decision, "no_match");
});

test("skips amount scoring when donation.amount is null", () => {
  const result = scoreDealCandidate(
    makeDonation({ amount: null }),
    makeCandidate({ amount: "500", contactAssociated: false }),
  );

  assert.equal(result.score, 0);
  assert.ok(!result.signals.includes("amount"));
});

// ─── findBestDealMatch ────────────────────────────────────────────────────────

test("returns no_match when no candidates", () => {
  const result = findBestDealMatch(makeDonation(), []);
  assert.equal(result.decision, "no_match");
  assert.equal(result.candidate, null);
});

test("returns no_match when all candidates score below threshold", () => {
  const result = findBestDealMatch(
    makeDonation({ amount: 100, companyName: null }),
    [makeCandidate({ contactAssociated: false, amount: "999", companyMatched: false })],
  );

  assert.equal(result.decision, "no_match");
});

test("returns auto_close for a single high-scoring candidate", () => {
  const result = findBestDealMatch(
    makeDonation({ amount: 500 }),
    [makeCandidate({ contactAssociated: true, amount: "500", companyMatched: false })],
  );

  assert.equal(result.decision, "auto_close");
  assert.equal(result.score, 90);
});

test("routes to needs_review when two candidates both score >= 80", () => {
  const candidates = [
    makeCandidate({ id: "deal-A", contactAssociated: true, amount: "500", companyMatched: false }),
    makeCandidate({ id: "deal-B", contactAssociated: true, amount: "500", companyMatched: false }),
  ];

  const result = findBestDealMatch(makeDonation({ amount: 500 }), candidates);

  assert.equal(result.decision, "needs_review");
  assert.ok(result.signals.includes("ambiguous_candidates"));
});

test("routes to needs_review when runner-up is within 15 points and >= 40", () => {
  // Best: contact + amount = 90; runner-up: contact only = 40 (within 15? no, diff=50)
  // Use contact+company=70 vs contact=40 — diff is 30, outside margin
  // Use contact+amount=90 vs contact+company=70 — diff is 20, outside 15
  // Use contact+amount=90 vs amount+company=80 — diff is 10, within 15, runner-up >= 80 → ambiguous
  const candidates = [
    makeCandidate({ id: "deal-A", contactAssociated: true, amount: "500", companyMatched: false }),
    makeCandidate({ id: "deal-B", contactAssociated: false, amount: "500", companyMatched: true }),
  ];

  // deal-A: 40+50 = 90; deal-B: 50+30 = 80. Runner-up >= 80 → ambiguous.
  const result = findBestDealMatch(makeDonation({ amount: 500, companyName: "Acme" }), candidates);

  assert.equal(result.decision, "needs_review");
  assert.ok(result.signals.includes("ambiguous_candidates"));
});

test("picks the highest-scoring candidate when no ambiguity", () => {
  const candidates = [
    makeCandidate({ id: "deal-low", contactAssociated: false, amount: "999", companyMatched: false }),
    makeCandidate({ id: "deal-high", contactAssociated: true, amount: "500", companyMatched: false }),
  ];

  const result = findBestDealMatch(makeDonation({ amount: 500 }), candidates);

  assert.equal(result.decision, "auto_close");
  assert.equal(result.candidate?.id, "deal-high");
});

// ─── DEAL_MATCH_PIPELINES ─────────────────────────────────────────────────────

test("DEAL_MATCH_PIPELINES contains Individual Donations, Grant, and Sponsorships", () => {
  assert.ok("155504019" in DEAL_MATCH_PIPELINES);
  assert.ok("802960948" in DEAL_MATCH_PIPELINES);
  assert.ok("806689671" in DEAL_MATCH_PIPELINES);
  assert.equal(DEAL_MATCH_PIPELINES["155504019"].closedStageId, "261678424");
  assert.equal(DEAL_MATCH_PIPELINES["802960948"].closedStageId, "1363931741");
  assert.equal(DEAL_MATCH_PIPELINES["806689671"].closedStageId, "1186687809");
});

// ─── findDealCandidates ───────────────────────────────────────────────────────

test("skips pre-created deal matching for donations at or below $1,000", async () => {
  const calls = [];
  const candidates = await findDealCandidates(
    makeClient(calls),
    "contact-1",
    makeDonation({ amount: 1000 }),
  );

  assert.deepEqual(candidates, []);
  assert.deepEqual(calls, []);
});

test("returns candidates from both contact association and amount passes, deduplicated", async () => {
  const calls = [];

  const client = makeClient(calls, {
    async getDealContactAssociations(id) {
      calls.push(["getDealContactAssociations", id]);
      if (id === "contact-1") return [{ toObjectId: "deal-A" }, { toObjectId: "deal-B" }];
      // deal-level calls
      return [];
    },
    async getDeals(ids) {
      calls.push(["getDeals", ids]);
      return ids.map((id) => makeRawDeal({ id, pipeline: "155504019", dealstage: "1135728530", amount: "1500" }));
    },
    async searchDeals(prop, value) {
      calls.push(["searchDeals", prop, value]);
      // amount search returns deal-B (dup) and a new deal-C
      return [
        makeRawDeal({ id: "deal-B", pipeline: "155504019", dealstage: "1135728530", amount: "1500" }),
        makeRawDeal({ id: "deal-C", pipeline: "802960948", dealstage: "1331736913", amount: "1500" }),
      ];
    },
  });

  const candidates = await findDealCandidates(client, "contact-1", makeDonation({ amount: 1500, companyName: null }));

  // Should have deal-A, deal-B (deduped), deal-C
  assert.equal(candidates.length, 3);
  const ids = candidates.map((c) => c.id);
  assert.ok(ids.includes("deal-A"));
  assert.ok(ids.includes("deal-B"));
  assert.ok(ids.includes("deal-C"));
});

test("skips deals in pipelines not in DEAL_MATCH_PIPELINES", async () => {
  const calls = [];
  const client = makeClient(calls, {
    async getDealContactAssociations(id) {
      if (id === "contact-1") return [{ toObjectId: "deal-out-of-scope" }];
      return [];
    },
    async getDeals() {
      // Out-of-scope pipeline
      return [makeRawDeal({ id: "deal-out-of-scope", pipeline: "153712251", dealstage: "1141642914", amount: "1500" })];
    },
    async searchDeals() {
      return [];
    },
  });

  const candidates = await findDealCandidates(client, "contact-1", makeDonation({ amount: 1500, companyName: null }));
  assert.equal(candidates.length, 0);
});

test("skips deals already stamped with a givebutter_transaction_id", async () => {
  const calls = [];
  const client = makeClient(calls, {
    async getDealContactAssociations(id) {
      if (id === "contact-1") return [{ toObjectId: "deal-already-done" }];
      return [];
    },
    async getDeals() {
      return [makeRawDeal({ id: "deal-already-done", pipeline: "155504019", dealstage: "1135728530", amount: "1500", txnId: "existing-txn" })];
    },
    async searchDeals() {
      return [];
    },
  });

  const candidates = await findDealCandidates(client, "contact-1", makeDonation({ amount: 1500, companyName: null }));
  assert.equal(candidates.length, 0);
});

test("sets contactAssociated=true when deal is linked to the contact", async () => {
  const client = makeClient([], {
    async getDealContactAssociations(id) {
      if (id === "contact-1") return [{ toObjectId: "deal-A" }];
      if (id === "deal-A") return [{ toObjectId: "contact-1" }];
      return [];
    },
    async getDeals() {
      return [makeRawDeal({ id: "deal-A", pipeline: "155504019", dealstage: "1135728530", amount: "1500" })];
    },
    async searchDeals() { return []; },
  });

  const candidates = await findDealCandidates(client, "contact-1", makeDonation({ amount: 1500, companyName: null }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contactAssociated, true);
});

test("sets companyMatched=true when a deal company name matches donation.companyName", async () => {
  const client = makeClient([], {
    async getDealContactAssociations() { return []; },
    async getDeals() { return []; },
    async searchDeals() {
      return [makeRawDeal({ id: "deal-A", pipeline: "802960948", dealstage: "1331736913", amount: "1500" })];
    },
    async getDealCompanyAssociations() {
      return [{ toObjectId: "company-1" }];
    },
    async getCompany() {
      return { id: "company-1", properties: { name: "Acme Corp", record_type: null } };
    },
  });

  const candidates = await findDealCandidates(client, null, makeDonation({ amount: 1500, companyName: "Acme Corp" }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].companyMatched, true);
});

// ─── Factories ────────────────────────────────────────────────────────────────

function makeDonation(overrides = {}) {
  return {
    transactionId: "txn-1",
    transactionNumber: "1234567890",
    contactId: "contact-1",
    planId: null,
    donorType: "person",
    firstName: "Jamie",
    lastName: "Donor",
    email: "jamie@example.org",
    phone: null,
    companyName: "Acme Corp",
    paymentMethod: "card",
    isOffline: false,
    isRecurring: false,
    amount: 500,
    feeCovered: null,
    currency: "USD",
    status: "succeeded",
    campaignId: "499886",
    campaignCode: "ABC123",
    campaignTitle: "PORCH Chapel Hill",
    createdAt: "2026-06-27T12:00:00.000Z",
    transactedAt: "2026-06-27T12:00:00.000Z",
    message: null,
    childTransactionCount: 1,
    hasFeeLineItem: false,
    dedication: { type: null, name: null, recipientName: null, recipientEmail: null },
    address: { company: null, line1: null, line2: null, city: null, state: null, postalCode: null, country: null },
    utm: { referrer: null, campaign: null, content: null, medium: null, source: null, term: null },
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    id: "deal-candidate-1",
    pipeline: "155504019",
    dealstage: "1135728530",
    amount: "500",
    planId: null,
    contactAssociated: false,
    companyMatched: false,
    ...overrides,
  };
}

function makeRawDeal({ id, pipeline, dealstage, amount, txnId = null, planId = null } = {}) {
  return {
    id,
    properties: {
      pipeline,
      dealstage,
      amount,
      givebutter_transaction_id: txnId,
      givebutter_plan_id: planId,
    },
  };
}

function makeClient(calls, overrides = {}) {
  return {
    async getDealContactAssociations(id) {
      calls.push(["getDealContactAssociations", id]);
      return [];
    },
    async getDealCompanyAssociations(id) {
      calls.push(["getDealCompanyAssociations", id]);
      return [];
    },
    async getDeals(ids, properties) {
      calls.push(["getDeals", ids, properties]);
      return [];
    },
    async getCompany(id) {
      calls.push(["getCompany", id]);
      return { id, properties: { name: null, record_type: null } };
    },
    async searchDeals(prop, value, properties) {
      calls.push(["searchDeals", prop, value, properties]);
      return [];
    },
    ...overrides,
  };
}
