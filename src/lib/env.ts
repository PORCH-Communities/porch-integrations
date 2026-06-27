const requiredEnvVars = [
  "GIVEBUTTER_API_KEY",
  "HUBSPOT_PRIVATE_APP_TOKEN",
  "HUBSPOT_CLIENT_SECRET",
  "ZAPIER_WEBHOOK_SECRET",
] as const;

export type RequiredEnvVar = (typeof requiredEnvVars)[number];

export function getEnv(name: RequiredEnvVar): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getMissingEnvVars(): RequiredEnvVar[] {
  return requiredEnvVars.filter((name) => !process.env[name]);
}
