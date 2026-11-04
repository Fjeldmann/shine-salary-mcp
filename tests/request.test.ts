import { describe, expect, it } from 'vitest';
import { listEndpoints } from '../src/api/allowlist.js';
import { buildRequest } from '../src/api/request.js';
import { COMPANY, EMPLOYEE } from './helpers.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
};

describe('allowlist', () => {
  it('contains only /v2 paths with UUID path params', () => {
    for (const e of listEndpoints()) {
      expect(e.path.startsWith('/v2/')).toBe(true);
      const names = [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(names).toEqual([...e.pathParams]);
    }
  });

  it('never allows a CPR number or export format in the query', () => {
    for (const e of listEndpoints()) {
      expect(Object.keys(e.query)).not.toContain('nationalID');
      expect(Object.keys(e.query)).not.toContain('format');
    }
  });

  it('documents why each undocumented endpoint is allowed', () => {
    for (const e of listEndpoints().filter((x) => !x.documented)) expect(e.note).toBeTruthy();
  });

  it('has unique ids', () => {
    const ids = listEndpoints().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildRequest', () => {
  it('builds a URL on the fixed origin', () => {
    const { url } = buildRequest('payRolls.list', { query: { companyID: COMPANY, from: '2026-01-01', to: '2026-12-31', limit: 10 } });
    expect(url.origin).toBe('https://api.salary.dk');
    expect(url.pathname).toBe('/v2/payRolls');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('substitutes and lower-cases UUID path params', () => {
    const { url } = buildRequest('employees.get', { path: { employeeID: EMPLOYEE.toUpperCase() } });
    expect(url.pathname).toBe(`/v2/employees/${EMPLOYEE}`);
  });

  it('rejects unlisted endpoints, including mutating ones that exist in the API', () => {
    expect(code(() => buildRequest('employments.terminate'))).toBe('ENDPOINT_NOT_ALLOWED');
    expect(code(() => buildRequest('/v2/companies'))).toBe('ENDPOINT_NOT_ALLOWED');
    expect(code(() => buildRequest('https://evil.example/v2/companies'))).toBe('ENDPOINT_NOT_ALLOWED');
    expect(code(() => buildRequest('__proto__'))).toBe('ENDPOINT_NOT_ALLOWED');
  });

  it.each([
    ['../companies'],
    ['..%2F..%2Fauth'],
    [`${EMPLOYEE}/../../auth`],
    [`${EMPLOYEE}%2F..`],
    ['https://evil.example/'],
    ['//evil.example/x'],
    [`${EMPLOYEE}?x=1`],
    [`${EMPLOYEE}#frag`],
    [''],
    ['not-a-uuid'],
  ])('rejects hostile path segment %j', (segment) => {
    expect(code(() => buildRequest('employees.get', { path: { employeeID: segment } }))).toBe('INVALID_PARAMS');
  });

  it('rejects missing and unknown path params', () => {
    expect(code(() => buildRequest('employees.get'))).toBe('INVALID_PARAMS');
    expect(code(() => buildRequest('employees.get', { path: { employeeID: EMPLOYEE, other: EMPLOYEE } }))).toBe('INVALID_PARAMS');
  });

  it('rejects unknown query keys, including ones Salary supports but we excluded', () => {
    expect(code(() => buildRequest('employees.list', { query: { companyID: COMPANY, nationalID: '0101011234' } }))).toBe('INVALID_PARAMS');
    expect(code(() => buildRequest('companies.list', { query: { apiKey: 'x' } }))).toBe('INVALID_PARAMS');
    expect(code(() => buildRequest('companies.list', { query: JSON.parse('{"__proto__":"x"}') as never }))).toBe('INVALID_PARAMS');
  });

  it('enforces required and one-of query params', () => {
    expect(code(() => buildRequest('payRolls.list', { query: { companyID: COMPANY, to: '2026-12-31' } }))).toBe('INVALID_PARAMS');
    expect(code(() => buildRequest('paySlips.list', { query: {} }))).toBe('INVALID_PARAMS');
    expect(code(() => buildRequest('paySlips.list', { query: { employeeID: EMPLOYEE } }))).toBe('no error');
  });

  it.each([
    ['companyID', 'abc'],
    ['from', '2026-02-30'],
    ['from', '2026-1-1'],
    ['limit', 0],
    ['limit', 1001],
    ['limit', 1.5],
    ['limit', '10'],
  ])('rejects bad value for %s: %j', (key, value) => {
    const query = { companyID: COMPANY, from: '2026-01-01', to: '2026-12-31', [key]: value };
    expect(code(() => buildRequest('payRolls.list', { query: query as never }))).toBe('INVALID_PARAMS');
  });

  it('rejects enum values outside the spec and unsafe employee numbers', () => {
    expect(code(() => buildRequest('timeRegistrations.list', { query: { companyID: COMPANY, stateFilter: 'All' } }))).toBe('INVALID_PARAMS');
    expect(code(() => buildRequest('employees.list', { query: { companyID: COMPANY, employeeNumber: 'a&companyID=x' } }))).toBe('INVALID_PARAMS');
    expect(code(() => buildRequest('employees.list', { query: { companyID: COMPANY, employeeNumber: 'Ø-12' } }))).toBe('no error');
  });
});
