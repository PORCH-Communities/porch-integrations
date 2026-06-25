import { NextResponse } from "next/server";

import {
  findBestHouseholdMatch,
  type HouseholdCandidate,
  type MatchableContact,
} from "@/lib/householding/matching";

type MatchHouseholdRequest = {
  contact: MatchableContact;
  candidates: HouseholdCandidate[];
};

export async function POST(request: Request) {
  const body = (await request.json()) as Partial<MatchHouseholdRequest>;

  if (!body.contact || !Array.isArray(body.candidates)) {
    return NextResponse.json(
      { error: "Expected contact and candidates in request body." },
      { status: 400 },
    );
  }

  return NextResponse.json(findBestHouseholdMatch(body.contact, body.candidates));
}
