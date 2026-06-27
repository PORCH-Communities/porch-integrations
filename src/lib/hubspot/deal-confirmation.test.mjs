import assert from "node:assert/strict";
import test from "node:test";

import { processDealMatchStatusChange } from "./deal-confirmation.ts";

// ─── processDealMatchStatusChange routing ────────────────────────────────────

test("routes 'confirmed' status to confirmDealMatch", async () => {
  const calls = [];
  const client = makeClient(calls, {
    async getDeal(id) {
      calls.push(["getDeal", id]);
      if (id === "holding-deal-1") {
        return makeDeal("holding-deal-1", {
          deal_match_status: "confirmed",
          candidate_deal_id: "candidate-deal-1",
          givebutter_transaction_id: "txn-abc",
          amount: "500",
        });
      }
      if (id === "candidate-deal-1") {
        return makeDeal("candidate-deal-1", {
          pipeline: "802960948",
          dealstage: "1331736913",
          givebutter_transaction_id: null,
        });
      }
      throw new Error(`Unexpected getDeal(${id})`);
    },
  });

  const result = await processDealMatchStatusChange(client, "holding-deal-1");
  assert.equal(result.status, "confirmed");
  assert.equal(result.holdingDealId, "holding-deal-1");
  assert.equal(result.candidateDealId, "candidate-deal-1");
});

test("routes 'no_match' status to rejectDealMatch", async () => {
  const calls = [];
  const client = makeClient(calls, {
    async getDeal(id) {
      calls.push(["getDeal", id]);
      return makeDeal(id, { deal_match_status: "no_match" });
    },
  });

  const result = await processDealMatchStatusChange(client, "holding-deal-1");
  assert.equal(result.status, "rejected");
  assert.equal(result.holdingDealId, "holding-deal-1");

  const updateCall = calls.find((c) => c[0] === "updateDealProperties");
  assert.ok(updateCall, "should call updateDealProperties");
  assert.equal(updateCall[1], "holding-deal-1");
  assert.equal(updateCall[2].deal_match_status, "unprocessed");
  assert.equal(updateCall[2].pipeline, "155504019");
  assert.equal(updateCall[2].dealstage, "261678424");
});

test("returns ignored_not_actionable for unrecognized status", async () => {
  const client = makeClient([], {
    async getDeal(id) {
      return makeDeal(id, { deal_match_status: "auto_closed" });
    },
  });

  const result = await processDealMatchStatusChange(client, "deal-1");
  assert.equal(result.status, "ignored_not_actionable");
  assert.ok(result.reason.includes("auto_closed"));
});

test("returns ignored_not_actionable for null status", async () => {
  const client = makeClient([], {
    async getDeal(id) {
      return makeDeal(id, { deal_match_status: null });
    },
  });

  const result = await processDealMatchStatusChange(client, "deal-1");
  assert.equal(result.status, "ignored_not_actionable");
});

// ─── confirmDealMatch: happy path ────────────────────────────────────────────

test("copies Givebutter fields to candidate and closes it in its own pipeline stage", async () => {
  const calls = [];
  const client = makeClient(calls, {
    async getDeal(id) {
      calls.push(["getDeal", id]);
      if (id === "holding-1") {
        return makeDeal("holding-1", {
          deal_match_status: "confirmed",
          candidate_deal_id: "candidate-1",
          givebutter_transaction_id: "txn-xyz",
          givebutter_reference_number: "1234567890",
          amount: "10000",
          closedate: "2026-06-16",
          givebutter_campaign: "My Campaign-D909XF",
          deal_match_score: "90",
          deal_match_signals: "contact_association,amount",
        });
      }
      if (id === "candidate-1") {
        return makeDeal("candidate-1", {
          pipeline: "802960948",   // Grant pipeline
          dealstage: "1331736913", // in-progress stage
          givebutter_transaction_id: null,
        });
      }
      throw new Error(`Unexpected getDeal(${id})`);
    },
    async getDealContactAssociations(id) {
      calls.push(["getDealContactAssociations", id]);
      if (id === "holding-1") return [{ toObjectId: "contact-99" }];
      return [];
    },
    async getDealCompanyAssociations(id) {
      calls.push(["getDealCompanyAssociations", id]);
      if (id === "holding-1") return [{ toObjectId: "company-42" }];
      return [];
    },
  });

  const result = await processDealMatchStatusChange(client, "holding-1");

  assert.equal(result.status, "confirmed");
  assert.equal(result.candidateDealId, "candidate-1");

  // updateDeal on candidate
  const updateCall = calls.find((c) => c[0] === "updateDeal" && c[1] === "candidate-1");
  assert.ok(updateCall, "should call updateDeal on candidate");
  assert.equal(updateCall[2].dealstage, "1363931741"); // Grant paid
  assert.equal(updateCall[2].deal_match_status, "auto_closed");
  assert.equal(updateCall[2].givebutter_transaction_id, "txn-xyz");
  assert.equal(updateCall[2].amount, "10000");

  // re-associate contact
  const assocContact = calls.find(
    (c) => c[0] === "associateContactToDeal" && c[2] === "candidate-1",
  );
  assert.ok(assocContact, "should associate contact to candidate deal");
  assert.equal(assocContact[1], "contact-99");

  // re-associate company
  const assocCompany = calls.find(
    (c) => c[0] === "associateDealToCompany" && c[1] === "candidate-1",
  );
  assert.ok(assocCompany, "should associate company to candidate deal");
  assert.equal(assocCompany[2], "company-42");

  // archive holding deal
  const archiveCall = calls.find((c) => c[0] === "archiveDeal");
  assert.ok(archiveCall, "should archive holding deal");
  assert.equal(archiveCall[1], "holding-1");
});

test("reports copiedFields from holding deal", async () => {
  const client = makeClient([], {
    async getDeal(id) {
      if (id === "holding-1") {
        return makeDeal("holding-1", {
          deal_match_status: "confirmed",
          candidate_deal_id: "candidate-1",
          givebutter_transaction_id: "txn-1",
          amount: "250",
          closedate: "2026-05-01",
        });
      }
      return makeDeal(id, { pipeline: "155504019", dealstage: "1135728530", givebutter_transaction_id: null });
    },
  });

  const result = await processDealMatchStatusChange(client, "holding-1");
  assert.equal(result.status, "confirmed");
  assert.ok(result.copiedFields.includes("givebutter_transaction_id"));
  assert.ok(result.copiedFields.includes("amount"));
  assert.ok(result.copiedFields.includes("closedate"));
});

// ─── confirmDealMatch: guard cases ───────────────────────────────────────────

test("returns needs_attention when holding deal has no candidate_deal_id", async () => {
  const client = makeClient([], {
    async getDeal(id) {
      return makeDeal(id, { deal_match_status: "confirmed", candidate_deal_id: null });
    },
  });

  const result = await processDealMatchStatusChange(client, "deal-1");
  assert.equal(result.status, "needs_attention");
  assert.ok(result.reason.includes("candidate_deal_id"));
});

test("returns needs_attention when candidate deal is in an unmanaged pipeline", async () => {
  const client = makeClient([], {
    async getDeal(id) {
      if (id === "holding-1") {
        return makeDeal("holding-1", {
          deal_match_status: "confirmed",
          candidate_deal_id: "candidate-1",
        });
      }
      // Some other pipeline not in DEAL_MATCH_PIPELINES
      return makeDeal(id, { pipeline: "153712251", givebutter_transaction_id: null });
    },
  });

  const result = await processDealMatchStatusChange(client, "holding-1");
  assert.equal(result.status, "needs_attention");
  assert.ok(result.reason.includes("153712251"));
});

test("returns needs_attention when candidate already has a Givebutter transaction ID", async () => {
  const client = makeClient([], {
    async getDeal(id) {
      if (id === "holding-1") {
        return makeDeal("holding-1", {
          deal_match_status: "confirmed",
          candidate_deal_id: "candidate-1",
          givebutter_transaction_id: "txn-incoming",
        });
      }
      return makeDeal(id, {
        pipeline: "802960948",
        dealstage: "1331736913",
        givebutter_transaction_id: "txn-already-set",
      });
    },
  });

  const result = await processDealMatchStatusChange(client, "holding-1");
  assert.equal(result.status, "needs_attention");
  assert.ok(result.reason.includes("txn-already-set"));
});

// ─── rejectDealMatch ─────────────────────────────────────────────────────────

test("rejectDealMatch promotes holding deal to Individual Donations and clears match fields", async () => {
  const calls = [];
  const client = makeClient(calls, {
    async getDeal(id) {
      return makeDeal(id, {
        deal_match_status: "no_match",
        candidate_deal_id: "candidate-1",
        deal_match_score: "65",
        deal_match_signals: "contact_association",
      });
    },
  });

  const result = await processDealMatchStatusChange(client, "holding-1");
  assert.equal(result.status, "rejected");

  const updateCall = calls.find((c) => c[0] === "updateDealProperties");
  assert.ok(updateCall, "should call updateDealProperties");
  const props = updateCall[2];
  assert.equal(props.pipeline, "155504019");
  assert.equal(props.dealstage, "261678424");
  assert.equal(props.deal_match_status, "unprocessed");
  assert.equal(props.candidate_deal_id, "");
  assert.equal(props.deal_match_score, "");
  assert.equal(props.deal_match_signals, "");
});

// ─── Factories ────────────────────────────────────────────────────────────────

function makeDeal(id, properties = {}) {
  return {
    id,
    properties: {
      pipeline: "155504019",
      dealstage: "1135728530",
      givebutter_transaction_id: null,
      givebutter_reference_number: null,
      deal_match_status: null,
      candidate_deal_id: null,
      deal_match_score: null,
      deal_match_signals: null,
      amount: null,
      closedate: null,
      givebutter_campaign: null,
      givebutter_company_name: null,
      givebutter_message: null,
      donor_address: null,
      dedication_name: null,
      dedication_type: null,
      dedication_recipient_name: null,
      dedication_recipient_email: null,
      referrer: null,
      utm_campaign: null,
      utm_content: null,
      utm_medium: null,
      utm_source: null,
      utm_term: null,
      ...properties,
    },
  };
}

function makeClient(calls, overrides = {}) {
  return {
    async getDeal(id) {
      calls.push(["getDeal", id]);
      return makeDeal(id);
    },
    async updateDeal(id, props) {
      calls.push(["updateDeal", id, props]);
      return makeDeal(id, props);
    },
    async updateDealProperties(id, props) {
      calls.push(["updateDealProperties", id, props]);
    },
    async archiveDeal(id) {
      calls.push(["archiveDeal", id]);
    },
    async getDealContactAssociations(id) {
      calls.push(["getDealContactAssociations", id]);
      return [];
    },
    async getDealCompanyAssociations(id) {
      calls.push(["getDealCompanyAssociations", id]);
      return [];
    },
    async associateContactToDeal(contactId, dealId) {
      calls.push(["associateContactToDeal", contactId, dealId]);
    },
    async associateDealToCompany(dealId, companyId) {
      calls.push(["associateDealToCompany", dealId, companyId]);
    },
    ...overrides,
  };
}
