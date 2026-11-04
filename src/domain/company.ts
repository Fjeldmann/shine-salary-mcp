import { Company } from '../api/schemas.js';
import { SalaryError } from '../errors.js';
import type { ToolContext } from './context.js';

export interface AuthorizedCompany {
  id: string;
  name: string;
}

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; companies: AuthorizedCompany[] } | undefined;

/** For tests. */
export function resetCompanyCache(): void {
  cache = undefined;
}

/** Companies the credentials can see (cached per process for a few minutes). */
export async function authorizedCompanies(ctx: ToolContext): Promise<AuthorizedCompany[]> {
  const now = ctx.now().getTime();
  if (cache && now - cache.at < TTL_MS) return cache.companies;
  const { items } = await ctx.list('companies.list', Company, { query: { limit: 100 } });
  cache = { at: now, companies: items.map((c) => ({ id: c.id.toLowerCase(), name: c.name })) };
  return cache.companies;
}

/** Every tool call names its company explicitly; it must be one the credentials can see. */
export async function requireCompany(ctx: ToolContext, companyId: string): Promise<AuthorizedCompany> {
  const found = (await authorizedCompanies(ctx)).find((c) => c.id === companyId.toLowerCase());
  if (!found) {
    throw new SalaryError('NOT_FOUND', 'That company is not available with the current credentials.', {
      hint: 'Call salary_company_overview without company_id to list the available companies.',
    });
  }
  return found;
}

/** Refuse records whose company does not match the requested company. */
export function assertSameCompany(actual: string | null | undefined, company: AuthorizedCompany, what: string): void {
  if (!actual || actual.toLowerCase() !== company.id) {
    throw new SalaryError('NOT_FOUND', `That ${what} does not belong to the selected company.`);
  }
}
