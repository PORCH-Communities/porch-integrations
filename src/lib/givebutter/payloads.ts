type JsonRecord = Record<string, unknown>;

export type GivebutterWebhookPayload = {
  id?: string | number | null;
  event?: string | null;
  data?: JsonRecord | null;
};

export type GivebutterDonation = {
  eventId: string | number | null;
  transactionId: string | number | null;
  transactionNumber: string | number | null;
  contactId: string | number | null;
  planId: string | number | null;
  donorType: "person" | "organization" | "unknown";
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  paymentMethod: string | null;
  isOffline: boolean;
  isRecurring: boolean;
  amount: number | null;
  feeCovered: number | null;
  currency: string | null;
  status: string | null;
  campaignId: string | number | null;
  campaignCode: string | null;
  campaignTitle: string | null;
  createdAt: string | null;
  transactedAt: string | null;
  message: string | null;
  childTransactionCount: number;
  hasFeeLineItem: boolean;
  dedication: {
    type: string | null;
    name: string | null;
    recipientName: string | null;
    recipientEmail: string | null;
  };
  address: {
    company: string | null;
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
  utm: {
    referrer: string | null;
    campaign: string | null;
    content: string | null;
    medium: string | null;
    source: string | null;
    term: string | null;
  };
};

export type GivebutterCampaign = {
  eventId: string | number | null;
  campaignId: string | number | null;
  campaignCode: string | null;
  campaignTitle: string | null;
};

export type GivebutterPayloadSummary = {
  topLevelKeys: string[];
  dataKeys: string[];
  present: Record<string, boolean>;
  missingRecommended: string[];
};

export function parseGivebutterWebhookPayload(rawBody: string): GivebutterWebhookPayload | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;

    if (!isRecord(parsed)) {
      return null;
    }

    return parsed as GivebutterWebhookPayload;
  } catch {
    return null;
  }
}

export function mapGivebutterDonation(payload: GivebutterWebhookPayload): GivebutterDonation {
  const data = asRecord(payload.data) ?? {};
  const address = asRecord(data.address) ?? {};
  const dedication = asRecord(data.dedication) ?? {};
  const dedicationRecipient = asRecord(dedication.recipient) ?? {};
  const givingSpace = asRecord(data.giving_space) ?? {};
  const attributionData = asRecord(data.attribution_data);
  const utmParameters = firstRecord(data.utm_parameters, attributionData) ?? {};
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  const firstTransaction = asRecord(transactions[0]) ?? {};
  const lineItems = transactions.flatMap((transaction) => {
    const record = asRecord(transaction);

    return Array.isArray(record?.line_items) ? record.line_items : [];
  });
  const companyName = firstString(data.company_name, data.company, address.company);
  const firstName = firstString(data.first_name);
  const lastName = firstString(data.last_name);

  return {
    eventId: firstId(payload.id),
    transactionId: firstId(data.id),
    transactionNumber: firstId(data.number, firstTransaction.id),
    contactId: firstId(data.contact_id),
    planId: firstId(data.plan_id, firstTransaction.plan_id),
    donorType: getDonorType({ companyName, firstName, lastName }),
    firstName,
    lastName,
    email: firstString(data.email),
    phone: firstString(data.phone),
    companyName,
    paymentMethod: firstString(data.payment_method, data.method),
    isOffline: data.is_offline === true,
    isRecurring:
      data.is_recurring === true ||
      transactions.some((transaction) => asRecord(transaction)?.is_recurring === true),
    amount: firstNumber(data.amount, firstTransaction.amount),
    feeCovered: firstNumber(data.fee_covered, firstTransaction.fee_covered),
    currency: firstString(data.currency),
    status: firstString(data.status),
    campaignId: firstId(data.campaign_id),
    campaignCode: firstString(data.campaign_code),
    campaignTitle: firstString(data.campaign_title),
    createdAt: firstString(data.created_at),
    transactedAt: firstString(data.transacted_at),
    message: firstString(givingSpace.message, data.message),
    childTransactionCount: transactions.length,
    hasFeeLineItem: lineItems.some((lineItem) => asRecord(lineItem)?.subtype === "fee"),
    dedication: {
      type: firstString(dedication.type),
      name: firstString(dedication.name),
      recipientName: firstString(
        dedication.recipient_name,
        dedication.recipient,
        dedicationRecipient.name,
      ),
      recipientEmail: firstString(dedication.recipient_email, dedicationRecipient.email),
    },
    address: {
      company: firstString(address.company),
      line1: firstString(address.address_1),
      line2: firstString(address.address_2),
      city: firstString(address.city),
      state: firstString(address.state),
      postalCode: firstString(address.zipcode, address.postal_code),
      country: firstString(address.country),
    },
    utm: {
      referrer: firstString(utmParameters.referer, utmParameters.referrer),
      campaign: firstString(utmParameters.utm_campaign),
      content: firstString(utmParameters.utm_content),
      medium: firstString(utmParameters.utm_medium),
      source: firstString(utmParameters.utm_source),
      term: firstString(utmParameters.utm_term),
    },
  };
}

export function mapGivebutterCampaign(payload: GivebutterWebhookPayload): GivebutterCampaign {
  const data = asRecord(payload.data) ?? {};

  return {
    eventId: firstId(payload.id),
    campaignId: firstId(data.id, data.campaign_id),
    campaignCode: firstString(data.code, data.campaign_code),
    campaignTitle: firstString(data.title, data.name, data.campaign_title),
  };
}

export function getFallbackEmail(donation: GivebutterDonation): string | null {
  if (donation.email && donation.email.trim().length > 0) {
    return donation.email;
  }

  if (!donation.contactId) {
    return null;
  }

  return `${donation.contactId}@porchcommunities.org`;
}

export function summarizeGivebutterDonationPayload(
  donation: GivebutterDonation,
  payload: GivebutterWebhookPayload,
): GivebutterPayloadSummary {
  const present = {
    eventId: hasValue(donation.eventId),
    transactionId: hasValue(donation.transactionId),
    transactionNumber: hasValue(donation.transactionNumber),
    contactId: hasValue(donation.contactId),
    planId: hasValue(donation.planId),
    email: hasValue(donation.email),
    donorName: hasValue(donation.firstName) || hasValue(donation.lastName),
    amount: hasValue(donation.amount),
    campaignId: hasValue(donation.campaignId),
    campaignCode: hasValue(donation.campaignCode),
    campaignTitle: hasValue(donation.campaignTitle),
    transactedAt: hasValue(donation.transactedAt),
    paymentMethod: hasValue(donation.paymentMethod),
    address: hasValue(donation.address.line1) || hasValue(donation.address.postalCode),
    company: hasValue(donation.companyName),
    organizationDonor: donation.donorType === "organization",
    offline: donation.isOffline,
    recurring: donation.isRecurring,
    utm: Object.values(donation.utm).some(hasValue),
    dedication: Object.values(donation.dedication).some(hasValue),
  };

  return {
    ...summarizePayloadKeys(payload),
    present,
    missingRecommended: missingKeys(present, [
      "transactionId",
      "transactionNumber",
      "amount",
      "campaignCode",
      "transactedAt",
    ]),
  };
}

export function summarizeGivebutterCampaignPayload(
  campaign: GivebutterCampaign,
  payload: GivebutterWebhookPayload,
): GivebutterPayloadSummary {
  const present = {
    eventId: hasValue(campaign.eventId),
    campaignId: hasValue(campaign.campaignId),
    campaignCode: hasValue(campaign.campaignCode),
    campaignTitle: hasValue(campaign.campaignTitle),
  };

  return {
    ...summarizePayloadKeys(payload),
    present,
    missingRecommended: missingKeys(present, ["campaignId", "campaignCode", "campaignTitle"]),
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function firstRecord(...values: unknown[]): JsonRecord | null {
  for (const value of values) {
    if (isRecord(value)) {
      return value;
    }
  }

  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function firstId(...values: unknown[]): string | number | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }

    if (typeof value === "number") {
      return value;
    }
  }

  return null;
}

function getDonorType(input: {
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
}): GivebutterDonation["donorType"] {
  if (input.companyName && !input.firstName && !input.lastName) {
    return "organization";
  }

  if (input.firstName || input.lastName) {
    return "person";
  }

  return input.companyName ? "organization" : "unknown";
}

function summarizePayloadKeys(payload: GivebutterWebhookPayload) {
  const data = asRecord(payload.data);

  return {
    topLevelKeys: Object.keys(payload).sort(),
    dataKeys: data ? Object.keys(data).sort() : [],
  };
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function missingKeys(present: Record<string, boolean>, requiredKeys: string[]): string[] {
  return requiredKeys.filter((key) => !present[key]);
}
