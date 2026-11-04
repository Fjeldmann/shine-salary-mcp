/**
 * The reviewed set of Salary API endpoints this server may call.
 *
 * Every entry was checked against https://api.salary.dk/swagger.json
 * (2026-11-04). Query keys are a deliberate subset of the spec: parameters
 * that would put personal data in a URL (e.g. `employees.nationalID`) or that
 * trigger exports (`format`) are left out. Only GET is possible; there is no
 * method field.
 *
 * Adding an endpoint is a security review: keep it to what a v1 tool needs.
 */

export type ParamSpec =
  | { type: 'uuid'; required?: boolean }
  | { type: 'date'; required?: boolean }
  | { type: 'boolean'; required?: boolean }
  | { type: 'int'; required?: boolean; min: number; max: number }
  | { type: 'string'; required?: boolean; maxLength: number; pattern?: RegExp }
  | { type: 'enum'; required?: boolean; values: readonly string[] };

export interface EndpointDef {
  /** Stable identifier used by tools and logs. */
  readonly id: string;
  /** Path template; `{name}` segments must appear in `pathParams`. */
  readonly path: string;
  /** Path parameters. All are UUIDs. */
  readonly pathParams: readonly string[];
  readonly query: Readonly<Record<string, ParamSpec>>;
  /** At least one of these query keys must be present. */
  readonly requireOneOf?: readonly string[];
  /** In the public spec. Undocumented endpoints need a written reason. */
  readonly documented: boolean;
  readonly note?: string;
}

const limit: ParamSpec = { type: 'int', min: 1, max: 1000 };
const offset: ParamSpec = { type: 'int', min: 0, max: 1_000_000 };
const page = { limit, offset } as const;

const ENDPOINTS = [
  // Company
  { id: 'companies.list', path: '/v2/companies', pathParams: [], query: { ...page }, documented: true },
  { id: 'companies.get', path: '/v2/companies/{companyID}', pathParams: ['companyID'], query: {}, documented: true },
  {
    id: 'companies.activePayrolls',
    path: '/v2/companies/{companyID}/activePayrolls',
    pathParams: ['companyID'],
    query: { employeeID: { type: 'uuid' } },
    documented: true,
  },
  {
    id: 'companies.statisticsOverview',
    path: '/v2/companies/{companyID}/statistics/overview',
    pathParams: ['companyID'],
    query: {},
    documented: true,
  },
  {
    id: 'warnings.list',
    path: '/v2/warnings',
    pathParams: [],
    query: { companyID: { type: 'uuid', required: true }, ...page },
    documented: true,
  },

  // Employees. `nationalID`/`nationalIDType` are excluded on purpose: a CPR
  // number must never appear in a URL.
  {
    id: 'employees.list',
    path: '/v2/employees',
    pathParams: [],
    query: {
      companyID: { type: 'uuid', required: true },
      employeeNumber: { type: 'string', maxLength: 64, pattern: /^[\p{L}\p{N} ._-]+$/u },
      includeRemuneration: { type: 'boolean' },
      ...page,
    },
    documented: true,
  },
  { id: 'employees.get', path: '/v2/employees/{employeeID}', pathParams: ['employeeID'], query: {}, documented: true },
  {
    id: 'employments.list',
    path: '/v2/employments',
    pathParams: [],
    query: { employeeID: { type: 'uuid' }, companyID: { type: 'uuid' }, ...page },
    requireOneOf: ['employeeID', 'companyID'],
    documented: true,
  },
  {
    id: 'employeeContracts.list',
    path: '/v2/employeeContracts',
    pathParams: [],
    query: {
      companyID: { type: 'uuid' },
      employeeID: { type: 'uuid' },
      employmentID: { type: 'uuid' },
      employmentType: { type: 'enum', values: ['Ordinary', 'Freelance'] },
      ...page,
    },
    requireOneOf: ['companyID', 'employeeID', 'employmentID'],
    documented: true,
  },
  {
    id: 'departments.list',
    path: '/v2/departments',
    pathParams: [],
    query: { companyID: { type: 'uuid', required: true } },
    documented: true,
  },

  // Payroll
  {
    id: 'payRolls.list',
    path: '/v2/payRolls',
    pathParams: [],
    // `from`/`to` are required by the spec; verified live (422 without `from`).
    query: {
      companyID: { type: 'uuid', required: true },
      from: { type: 'date', required: true },
      to: { type: 'date', required: true },
      ...page,
    },
    documented: true,
  },
  { id: 'payRolls.get', path: '/v2/payRolls/{payRollID}', pathParams: ['payRollID'], query: {}, documented: true },
  {
    id: 'payRollDeviations.list',
    path: '/v2/payRollDeviations',
    pathParams: [],
    query: { payRollID: { type: 'uuid', required: true } },
    documented: true,
  },
  {
    id: 'transfers.list',
    path: '/v2/transfers',
    pathParams: [],
    query: {
      payRollID: { type: 'uuid' },
      companyID: { type: 'uuid' },
      includeDetails: { type: 'boolean' },
      from: { type: 'date' },
      to: { type: 'date' },
      ...page,
    },
    requireOneOf: ['payRollID', 'companyID'],
    documented: true,
  },
  {
    id: 'paySlips.list',
    path: '/v2/paySlips',
    pathParams: [],
    query: {
      employeeID: { type: 'uuid' },
      payRollID: { type: 'uuid' },
      includeCalculations: { type: 'boolean' },
      ...page,
    },
    requireOneOf: ['employeeID', 'payRollID'],
    documented: true,
  },
  { id: 'paySlips.get', path: '/v2/paySlips/{paySlipID}', pathParams: ['paySlipID'], query: {}, documented: true },

  // Time and leave
  {
    id: 'timeRegistrations.list',
    path: '/v2/timeRegistrations',
    pathParams: [],
    query: {
      employeeID: { type: 'uuid' },
      companyID: { type: 'uuid' },
      payRollID: { type: 'uuid' },
      from: { type: 'date' },
      to: { type: 'date' },
      stateFilter: { type: 'enum', values: ['Pending', 'Settled', 'Cancelled'] },
      ...page,
    },
    requireOneOf: ['employeeID', 'companyID', 'payRollID'],
    documented: true,
  },
  {
    id: 'leaveTypes.list',
    path: '/v2/leaveTypes',
    pathParams: [],
    query: { companyID: { type: 'uuid', required: true }, ...page },
    documented: true,
  },

  // Credential self-check (not exposed as a tool).
  {
    id: 'apiKeys.list',
    path: '/v2/apiKeys',
    pathParams: [],
    query: { companyID: { type: 'uuid', required: true } },
    documented: false,
    note:
      'Not in the public spec. Used only by `status --check` to read the key\'s own scopes, ' +
      'which is the non-mutating proof that the key is read-only (verified 2026-11-04).',
  },
] as const satisfies readonly EndpointDef[];

export type EndpointId = (typeof ENDPOINTS)[number]['id'];

const BY_ID: ReadonlyMap<string, EndpointDef> = new Map(ENDPOINTS.map((e) => [e.id, e as EndpointDef]));

export function getEndpoint(id: string): EndpointDef | undefined {
  return BY_ID.get(id);
}

export function listEndpoints(): readonly EndpointDef[] {
  return [...BY_ID.values()];
}
