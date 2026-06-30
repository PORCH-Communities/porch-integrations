const HUBSPOT_API_BASE = "https://api.hubapi.com";

export type HubSpotContact = {
  id: string;
  properties: Record<string, string | null | undefined> & {
    household_match_status?: string | null;
    suggested_household_match?: string | null;
  };
  associations?: {
    companies?: { results?: Array<{ id: string }> };
    deals?: { results?: Array<{ id: string }> };
  };
};

export type HubSpotCompany = {
  id: string;
  properties: Record<string, string | null | undefined> & {
    name?: string | null;
    record_type?: string | null;
  };
};

export type HubSpotDeal = {
  id: string;
  properties: Record<string, string | null | undefined> & {
    givebutter_reference_number?: string | null;
    pipeline?: string | null;
  };
  associations?: {
    companies?: { results?: Array<{ id: string }> };
    contacts?: { results?: Array<{ id: string }> };
  };
};

export type HubSpotAssociationType = {
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
  typeId: number;
  label?: string | null;
};

export type HubSpotObjectAssociation = {
  toObjectId: number | string;
  associationTypes?: HubSpotAssociationType[];
};

export type HubSpotClient = {
  getContact(contactId: string): Promise<HubSpotContact>;
  getCompany(companyId: string): Promise<HubSpotCompany>;
  getDeal(dealId: string): Promise<HubSpotDeal>;
  getDeals(dealIds: string[], properties?: string[]): Promise<HubSpotDeal[]>;
  searchContacts(
    propertyName: string,
    value: string,
    properties?: string[],
  ): Promise<HubSpotContact[]>;
  searchCompanies(
    propertyName: string,
    value: string,
    properties?: string[],
  ): Promise<HubSpotCompany[]>;
  searchDeals(
    propertyName: string,
    value: string,
    properties?: string[],
  ): Promise<HubSpotDeal[]>;
  createContact(properties: Record<string, string>): Promise<HubSpotContact>;
  createCompany(properties: Record<string, string>): Promise<HubSpotCompany>;
  createDeal(properties: Record<string, string>): Promise<HubSpotDeal>;
  updateContact(contactId: string, properties: Record<string, string>): Promise<HubSpotContact>;
  updateDeal(dealId: string, properties: Record<string, string>): Promise<HubSpotDeal>;
  updateContactProperties(contactId: string, properties: Record<string, string>): Promise<void>;
  associateContactToDeal(contactId: string, dealId: string): Promise<void>;
  associateContactToDealWithType(
    contactId: string,
    dealId: string,
    associationTypeId: number,
  ): Promise<void>;
  associateContactToCompany(contactId: string, companyId: string): Promise<void>;
  associateDealToCompany(dealId: string, companyId: string): Promise<void>;
  getCompanyContactAssociations(companyId: string): Promise<HubSpotObjectAssociation[]>;
  getDealContactAssociations(dealId: string): Promise<HubSpotObjectAssociation[]>;
  getDealCompanyAssociations(dealId: string): Promise<HubSpotObjectAssociation[]>;
  updateDealProperties(dealId: string, properties: Record<string, string>): Promise<void>;
  archiveDeal(dealId: string): Promise<void>;
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
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetchImpl(`${HUBSPOT_API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });

      if (response.status === 429 && attempt < maxAttempts) {
        await delay(getRateLimitDelayMs(response.headers, attempt));
        continue;
      }

      if (!response.ok) {
        const body = (await response.text()).slice(0, 1000);
        throw new HubSpotApiError(response.status, `HubSpot API ${response.status}: ${body}`);
      }

      if (response.status === 204 || response.headers.get("content-length") === "0") {
        return undefined as T;
      }

      return (await response.json()) as T;
    }

    throw new HubSpotApiError(429, "HubSpot API rate limit retry budget exhausted.");
  }

  async function searchObjects<T>(
    objectType: "contacts" | "companies" | "deals",
    propertyName: string,
    value: string,
    properties: string[] = [],
  ): Promise<T[]> {
    const response = await request<{ results?: T[] }>(`/crm/v3/objects/${objectType}/search`, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [{ propertyName, operator: "EQ", value }],
          },
        ],
        properties,
        limit: 100,
      }),
    });

    return response.results ?? [];
  }

  async function createObject<T>(
    objectType: "contacts" | "companies" | "deals",
    properties: Record<string, string>,
  ): Promise<T> {
    return request<T>(`/crm/v3/objects/${objectType}`, {
      method: "POST",
      body: JSON.stringify({ properties }),
    });
  }

  async function updateObject<T>(
    objectType: "contacts" | "deals",
    objectId: string,
    properties: Record<string, string>,
  ): Promise<T> {
    return request<T>(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  }

  async function associateContactToDealWithType(
    contactId: string,
    dealId: string,
    associationTypeId: number,
  ): Promise<void> {
    await request(
      `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/deals/${encodeURIComponent(dealId)}`,
      {
        method: "PUT",
        body: JSON.stringify([
          {
            associationCategory: "USER_DEFINED",
            associationTypeId,
          },
        ]),
      },
    );
  }

  return {
    getContact(contactId) {
      const properties = "household_match_status,suggested_household_match";

      return request<HubSpotContact>(
        `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${properties}&associations=companies,deals`,
      );
    },

    getCompany(companyId) {
      return request<HubSpotCompany>(
        `/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=name,record_type`,
      );
    },

    getDeal(dealId) {
      const properties = [
        "pipeline",
        "dealstage",
        "givebutter_reference_number",
        "givebutter_transaction_id",
        "givebutter_plan_id",
        "givebutter_is_recurring",
        "recurring_communication_type",
        "recurring_anniversary_number",
        "recurring_plan_start_date",
        "suppress_automated_communications",
        "deal_match_status",
        "candidate_deal_id",
        "deal_match_score",
        "deal_match_signals",
        "amount",
        "closedate",
        "givebutter_campaign",
        "givebutter_company_name",
        "givebutter_message",
        "donor_address",
        "dedication_name",
        "dedication_type",
        "dedication_recipient_name",
        "dedication_recipient_email",
        "referrer",
        "utm_campaign",
        "utm_content",
        "utm_medium",
        "utm_source",
        "utm_term",
      ].join(",");

      return request<HubSpotDeal>(
        `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${properties}&associations=companies,contacts`,
      );
    },

    async getDeals(dealIds, properties) {
      if (dealIds.length === 0) {
        return [];
      }

      const response = await request<{ results?: HubSpotDeal[] }>(
        "/crm/v3/objects/deals/batch/read",
        {
          method: "POST",
          body: JSON.stringify({
            properties: properties ?? ["pipeline"],
            inputs: dealIds.map((id) => ({ id })),
          }),
        },
      );

      return response.results ?? [];
    },

    searchContacts(propertyName, value, properties) {
      return searchObjects<HubSpotContact>("contacts", propertyName, value, properties);
    },

    searchCompanies(propertyName, value, properties) {
      return searchObjects<HubSpotCompany>("companies", propertyName, value, properties);
    },

    searchDeals(propertyName, value, properties) {
      return searchObjects<HubSpotDeal>("deals", propertyName, value, properties);
    },

    createContact(properties) {
      return createObject<HubSpotContact>("contacts", properties);
    },

    createCompany(properties) {
      return createObject<HubSpotCompany>("companies", properties);
    },

    createDeal(properties) {
      return createObject<HubSpotDeal>("deals", properties);
    },

    updateContact(contactId, properties) {
      return updateObject<HubSpotContact>("contacts", contactId, properties);
    },

    updateDeal(dealId, properties) {
      return updateObject<HubSpotDeal>("deals", dealId, properties);
    },

    async updateContactProperties(contactId, properties) {
      await request(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
    },

    async associateContactToDeal(contactId, dealId) {
      await request(
        `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/deals/${encodeURIComponent(dealId)}`,
        { method: "PUT" },
      );
    },

    associateContactToDealWithType,

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

    async getCompanyContactAssociations(companyId) {
      const response = await request<{ results?: HubSpotObjectAssociation[] }>(
        `/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/contacts?limit=500`,
      );

      return response.results ?? [];
    },

    async getDealContactAssociations(dealId) {
      const response = await request<{ results?: HubSpotObjectAssociation[] }>(
        `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/contacts?limit=500`,
      );

      return response.results ?? [];
    },

    async getDealCompanyAssociations(dealId) {
      const response = await request<{ results?: HubSpotObjectAssociation[] }>(
        `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/companies?limit=500`,
      );

      return response.results ?? [];
    },

    async updateDealProperties(dealId, properties) {
      await request(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
    },

    async archiveDeal(dealId) {
      await request(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
        method: "DELETE",
      });
    },

  };
}

function getRateLimitDelayMs(headers: Headers, attempt: number): number {
  const retryAfter = headers.get("retry-after");

  if (retryAfter !== null) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }

    const retryAt = Date.parse(retryAfter);

    if (Number.isFinite(retryAt)) {
      return Math.min(Math.max(retryAt - Date.now(), 0), 10_000);
    }
  }

  const interval = Number(headers.get("x-hubspot-ratelimit-interval-milliseconds"));

  if (Number.isFinite(interval) && interval > 0) {
    return Math.min(interval, 10_000);
  }

  return Math.min(1000 * 2 ** (attempt - 1), 10_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
