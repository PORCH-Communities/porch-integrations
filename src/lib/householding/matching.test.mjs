import assert from "node:assert/strict";
import test from "node:test";

import {
  findBestHouseholdMatch,
  getEmailDomain,
  normalizeLastName,
  normalizeStreet,
  normalizeZip,
  scoreHouseholdCandidate,
} from "./matching.ts";

const smithHousehold = {
  hubspotCompanyId: "company-smith",
  householdName: "Smith Household",
  lastName: "Smith",
  street: "123 Main St",
  zip: "27516",
};

test("normalizes household matching fields", () => {
  assert.equal(normalizeLastName(" O'Connor-Smith! "), "oconnor-smith");
  assert.equal(normalizeStreet("123 Main Street Apt 4B"), "123 main st");
  assert.equal(normalizeZip("27516-1234"), "27516");
  assert.equal(getEmailDomain("person@gmail.com"), "");
  assert.equal(getEmailDomain("person@porchcommunities.org"), "porchcommunities.org");
});

test("scores a strong household match", () => {
  const result = scoreHouseholdCandidate(
    {
      lastName: "Smith",
      street: "123 Main Street, Unit 2",
      zip: "27516-1234",
    },
    smithHousehold,
  );

  assert.equal(result.score, 105);
  assert.equal(result.decision, "auto_household");
  assert.deepEqual(result.signals, ["last_name", "street", "zip", "street_zip_bonus"]);
});

test("auto-households one clearly superior candidate", () => {
  const result = findBestHouseholdMatch(
    {
      lastName: "Smith",
      street: "123 Main Street",
      zip: "27516",
    },
    [
      smithHousehold,
      {
        hubspotCompanyId: "company-other-smith",
        householdName: "Other Smith Household",
        lastName: "Smith",
        street: "900 Other Road",
        zip: "90210",
      },
    ],
  );

  assert.equal(result.candidate?.hubspotCompanyId, "company-smith");
  assert.equal(result.decision, "auto_household");
  assert.equal(result.score, 105);
});

test("routes multiple high-confidence candidates to review", () => {
  const result = findBestHouseholdMatch(
    {
      lastName: "Smith",
      street: "123 Main Street",
      zip: "27516",
    },
    [
      smithHousehold,
      {
        hubspotCompanyId: "company-smith-duplicate",
        householdName: "Smith Household Duplicate",
        lastName: "Smith",
        street: "123 Main Street",
        zip: "27516",
      },
    ],
  );

  assert.equal(result.decision, "needs_review");
  assert.equal(result.score, 105);
  assert.ok(result.signals.includes("ambiguous_candidates"));
});

test("routes a close plausible runner-up to review", () => {
  const result = findBestHouseholdMatch(
    {
      lastName: "Smith",
      street: "123 Main Street",
      zip: "27516",
      email: "donor@porchcommunities.org",
    },
    [
      {
        ...smithHousehold,
        zip: "99999",
      },
      {
        hubspotCompanyId: "company-close-runner-up",
        householdName: "Smith Family",
        lastName: "Smith",
        street: "999 Other Road",
        zip: "27516",
        email: "member@porchcommunities.org",
      },
    ],
  );

  assert.equal(result.score, 80);
  assert.equal(result.decision, "needs_review");
  assert.ok(result.signals.includes("ambiguous_candidates"));
});

test("returns no match when identity or candidates are missing", () => {
  assert.deepEqual(findBestHouseholdMatch({ street: "123 Main St" }, [smithHousehold]), {
    candidate: null,
    decision: "no_match",
    score: 0,
    signals: ["missing_last_name"],
  });

  assert.deepEqual(findBestHouseholdMatch({ lastName: "Smith" }, []), {
    candidate: null,
    decision: "no_match",
    score: 0,
    signals: ["no_candidates"],
  });
});
