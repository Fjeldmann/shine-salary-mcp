/**
 * Opt-in live smoke test against the real Salary API, using only GETs through
 * the allowlisted client. Prints counts and scope names, never tokens, keys or
 * personal data.
 *
 *   npm run build && SHINE_SALARY_DEV_ENV_CREDENTIALS=1 npm run smoke:live
 */
import { RequestBudget, SalaryClient } from '../api/client.js';
import { ApiCredentialTokenProvider } from '../auth/api-client.js';
import { readDevEnvCredentials } from '../auth/env-credentials.js';
import { checkAccess } from '../commands/check-access.js';
import { isSalaryError } from '../errors.js';

function count(body: unknown): number | string {
  const data = (body as { data?: unknown })?.data;
  return Array.isArray(data) ? data.length : typeof data;
}

try {
  const tokens = new ApiCredentialTokenProvider(readDevEnvCredentials());
  const report = await checkAccess(tokens);
  console.log(`companies: ${report.companies.length}`);
  console.log(`key scopes: ${report.keys.map((k) => k.scopes.join('+')).join(', ')}; read-only confirmed: ${report.readOnly}`);

  const companyID = report.companies[0]?.id;
  if (!companyID) throw new Error('No company visible to these credentials.');
  const client = new SalaryClient({ tokenProvider: tokens });
  const budget = new RequestBudget(10);
  const year = new Date().getUTCFullYear();
  const checks = [
    ['employees.list', { query: { companyID, limit: 1 } }],
    ['payRolls.list', { query: { companyID, from: `${year}-01-01`, to: `${year}-12-31`, limit: 5 } }],
    ['departments.list', { query: { companyID } }],
    ['leaveTypes.list', { query: { companyID, limit: 5 } }],
  ] as const;
  for (const [id, params] of checks) {
    const res = await client.get(id, params, { budget });
    console.log(`${id}: HTTP ${res.status}, ${count(res.body)} rows`);
  }
  console.log('live smoke: OK');
} catch (err) {
  console.error(isSalaryError(err) ? `live smoke FAILED [${err.code}] ${err.message}` : `live smoke FAILED: ${(err as Error).name}`);
  process.exit(1);
}
