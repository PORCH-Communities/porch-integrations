const HUBSPOT_API_BASE = "https://api.hubapi.com";

export type HubSpotContact = {
  id: string;
  properties: {
    household_match_status?: string | null;
    suggested_household_match?: string | null;
  };
  associations?: {
    deals?: { results?: Array<{ id: string }> };
  };
};

export type HubSpotCompany = {
  id: string;
  properties: {
    name?: string | null;
    record_type?: string | null;
  };
};

export type HubSpotDeal = {
  id: string;
  properties: {
    pipeline?: string | null;
  };
};

export type HubSpotClient = {
  getContact(contactId: string): Promise<HubSpotContact>;
  getCompany(companyId: string): Promise<HubSpotCompany>;
  getDeals(dealIds: string[]): Promise<HubSpotDeal[]>;
  associateContactToCompany(contactId: string, companyId: string): Promise<void>;
  associateDealToCompany(dealId: string, companyId: string): Promise<void>;
};

export class HubSpotApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HubSpotApiError";
    this.status = status;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export function createHubSpotClient(input?: {
  accessToken?: string;
  fetchImpl?: typeof fetch;
}): HubSpotClient {
  const accessToken = input?.accessToken ?? process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const fetchImpl = input?.fetchImpl ?? fetch;

  if (!accessToken) {
    throw new Error("Missing required environment variable: HUBSPOT_PRIVATE_APP_TOKEN");
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${HUBSPOT_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      throw new HubSpotApiError(response.status, `HubSpot API ${response.status}: ${body}`);
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  return {
    getContact(contactId) {
      const properties = "household_match_status,suggested_household_match";

      return request<HubSpotContact>(
        `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${properties}&associations=deals`,
      );
    },

    getCompany(companyId) {
      return request<HubSpotCompany>(
        `/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=name,record_type`,
      );
    },

    async getDeals(dealIds) {
      if (dealIds.length === 0) {
        return [];
      }

      const response = await request<{ results?: HubSpotDeal[] }>(
        "/crm/v3/objects/deals/batch/read",
        {
          method: "POST",
          body: JSON.stringify({
            properties: ["pipeline"],
            inputs: dealIds.map((id) => ({ id })),
          }),
        },
      );

      return response.results ?? [];
    },

    async associateContactToCompany(contactId, companyId) {
      await request(
        `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
        { method: "PUT" },
      );
    },

    async associateDealToCompany(dealId, companyId) {
      await request(
        `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
        { method: "PUT" },
      );
    },
  };
}
