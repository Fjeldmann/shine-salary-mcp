import { SalaryError } from '../errors.js';
import { getEndpoint, type EndpointDef, type EndpointId, type ParamSpec } from './allowlist.js';

/** The only origin the data client and the auth adapter may contact. */
export const SALARY_ORIGIN = 'https://api.salary.dk';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type QueryValue = string | number | boolean;

export interface RequestParams {
  path?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, QueryValue | undefined>>;
}

export interface BuiltRequest {
  endpoint: EndpointDef;
  url: URL;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function invalid(endpoint: string, message: string): SalaryError {
  return new SalaryError('INVALID_PARAMS', message, { endpoint });
}

function serialiseQueryValue(endpointId: string, key: string, spec: ParamSpec, value: QueryValue): string {
  switch (spec.type) {
    case 'uuid':
      if (!isUuid(value)) throw invalid(endpointId, `Query parameter "${key}" must be a UUID.`);
      return value.toLowerCase();
    case 'date':
      if (!isIsoDate(value)) throw invalid(endpointId, `Query parameter "${key}" must be a date (YYYY-MM-DD).`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(endpointId, `Query parameter "${key}" must be a boolean.`);
      return value ? 'true' : 'false';
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
        throw invalid(endpointId, `Query parameter "${key}" must be an integer from ${spec.min} to ${spec.max}.`);
      }
      return String(value);
    case 'string':
      if (typeof value !== 'string' || value.length === 0 || value.length > spec.maxLength) {
        throw invalid(endpointId, `Query parameter "${key}" must be a string of 1-${spec.maxLength} characters.`);
      }
      if (spec.pattern && !spec.pattern.test(value)) {
        throw invalid(endpointId, `Query parameter "${key}" contains characters that are not allowed.`);
      }
      return value;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        throw invalid(endpointId, `Query parameter "${key}" must be one of: ${spec.values.join(', ')}.`);
      }
      return value;
  }
}

/**
 * Turn an endpoint identifier plus parameters into a URL on the fixed origin.
 * Throws before any network activity if anything is outside the allowlist.
 */
export function buildRequest(endpointId: EndpointId | string, params: RequestParams = {}): BuiltRequest {
  const endpoint = getEndpoint(endpointId);
  if (!endpoint) {
    throw new SalaryError('ENDPOINT_NOT_ALLOWED', `Endpoint "${endpointId}" is not on the allowlist.`);
  }

  const pathValues = params.path ?? {};
  for (const key of Object.keys(pathValues)) {
    if (!endpoint.pathParams.includes(key)) throw invalid(endpoint.id, `Unknown path parameter "${key}".`);
  }
  let path = endpoint.path;
  for (const name of endpoint.pathParams) {
    const value = pathValues[name];
    if (!isUuid(value)) throw invalid(endpoint.id, `Path parameter "${name}" must be a UUID.`);
    path = path.replace(`{${name}}`, value.toLowerCase());
  }

  const url = new URL(path, SALARY_ORIGIN);
  // Defence in depth: the template and UUID check make these impossible, but
  // the guarantee is cheap to assert.
  if (url.origin !== SALARY_ORIGIN || url.pathname !== path || path.includes('{')) {
    throw new SalaryError('ENDPOINT_NOT_ALLOWED', 'Constructed URL left the allowed origin or path.', {
      endpoint: endpoint.id,
    });
  }

  const query = params.query ?? {};
  for (const [key, value] of Object.entries(query)) {
    if (!Object.hasOwn(endpoint.query, key)) throw invalid(endpoint.id, `Unknown query parameter "${key}".`);
    if (value === undefined) continue;
    const spec = endpoint.query[key] as ParamSpec;
    url.searchParams.set(key, serialiseQueryValue(endpoint.id, key, spec, value));
  }
  for (const [key, spec] of Object.entries(endpoint.query)) {
    if (spec.required && !url.searchParams.has(key)) {
      throw invalid(endpoint.id, `Query parameter "${key}" is required.`);
    }
  }
  if (endpoint.requireOneOf && !endpoint.requireOneOf.some((k) => url.searchParams.has(k))) {
    throw invalid(endpoint.id, `One of these query parameters is required: ${endpoint.requireOneOf.join(', ')}.`);
  }

  return { endpoint, url };
}
