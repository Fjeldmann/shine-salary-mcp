import { RequestBudget, SalaryClient, type TokenProvider } from '../api/client.js';
import type { FetchLike } from '../api/http.js';
import { ApiKeysResponse, CompaniesResponse, parseResponse, VERIFIED_READ_ONLY_SCOPES } from '../api/schemas.js';

export interface AccessReport {
  companies: Array<{ id: string; name: string }>;
  keys: Array<{ companyID: string; description: string | null; scopes: string[]; verifiedReadOnly: boolean }>;
  readOnly: boolean;
}

/**
 * Logs in and confirms what the credentials can see, using only GETs:
 * the companies bound to the key and the key's own scopes. Never a mutation probe.
 */
export async function checkAccess(tokens: TokenProvider, opts: { fetch?: FetchLike; signal?: AbortSignal } = {}): Promise<AccessReport> {
  const client = new SalaryClient({ tokenProvider: tokens, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const budget = new RequestBudget(10);
  const get = { budget, ...(opts.signal ? { signal: opts.signal } : {}) };

  const companies = parseResponse(CompaniesResponse, (await client.get('companies.list', {}, get)).body, 'companies.list').data;
  const keys: AccessReport['keys'] = [];
  for (const company of companies) {
    const res = await client.get('apiKeys.list', { query: { companyID: company.id } }, get);
    for (const key of parseResponse(ApiKeysResponse, res.body, 'apiKeys.list').data) {
      keys.push({
        companyID: key.companyID,
        description: key.description ?? null,
        scopes: key.scopes,
        verifiedReadOnly: key.scopes.length > 0 && key.scopes.every((s) => VERIFIED_READ_ONLY_SCOPES.has(s)),
      });
    }
  }
  return {
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
    keys,
    readOnly: keys.length > 0 && keys.every((k) => k.verifiedReadOnly),
  };
}
