import { NextRequest } from "next/server";

export function verifyZapierSecret(request: NextRequest): boolean {
  const configuredSecret = process.env.ZAPIER_WEBHOOK_SECRET;
  const providedSecret = request.headers.get("x-porch-webhook-secret");

  if (!configuredSecret) {
    return false;
  }

  return providedSecret === configuredSecret;
}
