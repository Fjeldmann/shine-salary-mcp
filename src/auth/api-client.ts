import { SalaryError } from '../errors.js';
import { isRedirectStatus, mapFetchError, readBodyCapped, USER_AGENT, type FetchLike } from '../api/http.js';
import { isUuid, SALARY_ORIGIN } from '../api/request.js';
import type { TokenProvider } from '../api/client.js';

/**
 * The authentication adapter. It is the only code allowed to send a
 * non-GET request, and it can only POST the three credential fields to
 * `/v2/auth`. Nothing here accepts a path, method or body from a caller.
 */

export interface ApiCredentials {
  apiClientID: string;
  apiClientSecret: string;
  apiKey: string;
}

export interface AccessToken {
  accessToken: string;
  obtainedAt: number;
  /**
   * Estimated expiry. Salary returns an opaque token with no expiry metadata
   * (verified 2026-11-04); the spec says "around one hour". 401 handling is
   * the real signal, this only avoids using a token we expect to be stale.
   */
  expiresAt: number;
}

const AUTH_URL = new URL('/v2/auth', SALARY_ORIGIN);
const ASSUMED_LIFETIME_MS = 50 * 60 * 1000;

export interface ExchangeOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

export async function exchangeApiCredentials(creds: ApiCredentials, opts: ExchangeOptions = {}): Promise<AccessToken> {
  if (!isUuid(creds.apiClientID)) {
    throw new SalaryError('CREDENTIALS_REJECTED', 'The API client ID must be a UUID.', {
      hint: 'Copy the client ID from the email Salary sent when they registered the API client.',
    });
  }
  if (!creds.apiClientSecret || !creds.apiKey) {
    throw new SalaryError('AUTH_REQUIRED', 'The API client secret and the company API key are both required.');
  }

  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const endpoint = 'auth';

  let res: Response;
  let text: string;
  try {
    res = await doFetch(AUTH_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        apiClientID: creds.apiClientID,
        apiClientSecret: creds.apiClientSecret,
        apiKey: creds.apiKey,
      }),
      signal,
    });
    if (isRedirectStatus(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new SalaryError('REDIRECT_BLOCKED', 'The Salary login endpoint answered with a redirect.', {
        status: res.status,
        endpoint,
      });
    }
    text = await readBodyCapped(res, 64 * 1024, endpoint);
  } catch (err) {
    throw mapFetchError(err, opts.signal, endpoint);
  }

  if (res.status === 404) {
    // Salary answers 404 "API Client not found" for an unknown client ID,
    // before it checks the secret (verified 2026-11-04).
    throw new SalaryError('CREDENTIALS_REJECTED', 'Salary does not recognise the API client ID.', {
      status: 404,
      endpoint,
      hint: 'Check that the full client ID from Salary\'s email was copied.',
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new SalaryError('CREDENTIALS_REJECTED', 'Salary rejected the API client secret or the company API key.', {
      status: res.status,
      endpoint,
      hint: 'Check the client secret, and that the company API key has not been deleted.',
    });
  }
  if (res.status === 429) {
    throw new SalaryError('RATE_LIMITED', 'Salary is rate limiting logins.', { status: 429, endpoint });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SalaryError('UPSTREAM_ERROR', `The Salary login endpoint returned HTTP ${res.status}.`, {
      status: res.status,
      endpoint,
    });
  }

  let token: unknown;
  try {
    token = (JSON.parse(text) as { data?: { accessToken?: unknown } }).data?.accessToken;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || token.length < 16 || token.length > 4096 || /\s/.test(token)) {
    throw new SalaryError('BAD_RESPONSE', 'The Salary login response did not contain a usable access token.', {
      status: res.status,
      endpoint,
    });
  }
  const obtainedAt = now();
  return { accessToken: token, obtainedAt, expiresAt: obtainedAt + ASSUMED_LIFETIME_MS };
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SalaryError('CANCELLED', 'The request was cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SalaryError('CANCELLED', 'The request was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * In-memory token provider for API credentials, with single-flight renewal.
 * Milestone 3 adds the persisted token record and the cross-process lock.
 */
export class ApiCredentialTokenProvider implements TokenProvider {
  readonly #creds: ApiCredentials;
  readonly #opts: ExchangeOptions;
  readonly #now: () => number;
  readonly #marginMs: number;
  #current: AccessToken | undefined;
  #pending: Promise<AccessToken> | undefined;

  constructor(creds: ApiCredentials, opts: ExchangeOptions & { safetyMarginMs?: number } = {}) {
    this.#creds = creds;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#marginMs = opts.safetyMarginMs ?? 2 * 60 * 1000;
  }

  async getToken(signal?: AbortSignal): Promise<string> {
    const current = this.#current;
    if (current && current.expiresAt - this.#marginMs > this.#now()) return current.accessToken;
    // The exchange is shared by concurrent callers, so it is not tied to one
    // caller's signal; a cancelled caller just stops waiting for it.
    this.#pending ??= exchangeApiCredentials(this.#creds, this.#opts)
      .then((t) => {
        // Stored here, not by the awaiting caller, so the token survives even
        // if every caller is cancelled while the exchange runs.
        this.#current = t;
        return t;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    const fresh = signal ? await abortable(this.#pending, signal) : await this.#pending;
    return fresh.accessToken;
  }

  invalidate(token: string): void {
    if (this.#current?.accessToken === token) this.#current = undefined;
  }
}
