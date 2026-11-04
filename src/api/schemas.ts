import { z } from 'zod';
import { SalaryError } from '../errors.js';

/**
 * Reviewed response schemas. Objects are loose: Salary may add fields at any
 * time (spec versioning policy), and unknown enum values must not break
 * parsing, so enums are plain strings here and interpreted by tools.
 */

export const Pagination = z.looseObject({
  offset: z.number().optional(),
  count: z.number().optional(),
  totalCount: z.number().optional(),
});

export function listEnvelope<T extends z.ZodType>(item: T) {
  return z.looseObject({ data: z.array(item), pagination: Pagination.optional() });
}

export function itemEnvelope<T extends z.ZodType>(item: T) {
  return z.looseObject({ data: item });
}

export const Company = z.looseObject({
  id: z.uuid(),
  name: z.string(),
});
export type Company = z.infer<typeof Company>;

/** `/v2/apiKeys` (undocumented): only the fields `status --check` reads. The key value is never parsed. */
export const ApiKeyInfo = z.looseObject({
  id: z.string(),
  companyID: z.uuid(),
  description: z.string().nullish(),
  scopes: z.array(z.string()),
  createdAt: z.string().optional(),
});
export type ApiKeyInfo = z.infer<typeof ApiKeyInfo>;

export const CompaniesResponse = listEnvelope(Company);
export const ApiKeysResponse = listEnvelope(ApiKeyInfo);

/**
 * Scope names verified to be read-only. Only `ReadAll` has been observed
 * (2026-11-04); the narrower read scopes' API names are unknown, so any other
 * value makes `status --check` ask the user to confirm it in Salary's UI.
 */
export const VERIFIED_READ_ONLY_SCOPES: ReadonlySet<string> = new Set(['ReadAll']);

export function parseResponse<T extends z.ZodType>(schema: T, body: unknown, endpoint: string): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    // Report paths only: issue messages can echo values.
    const paths = result.error.issues
      .slice(0, 5)
      .map((i) => i.path.join('.') || '(root)')
      .join(', ');
    throw new SalaryError('BAD_RESPONSE', `Unexpected response shape from ${endpoint} at: ${paths}.`, { endpoint });
  }
  return result.data;
}
