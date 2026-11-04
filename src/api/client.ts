import { SalaryError, type ErrorCode } from '../errors.js';
import { scrubText } from '../privacy/redact.js';
import type { EndpointId } from './allowlist.js';
import { isRedirectStatus, mapFetchError, parseRetryAfter, readBodyCapped, USER_AGENT, type FetchLike } from './http.js';
import { buildRequest, type RequestParams } from './request.js';

/**
 * Supplies access tokens. Milestone 3 backs this with the secure store and a
 * cross-process lock; the data client only needs these two operations.
 */
export interface TokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
  /** Called with the token that was rejected, so a newer token is kept. */
  invalidate(token: string): void;
}

export interface SalaryClientOptions {
  tokenProvider: TokenProvider;
  fetch?: FetchLike;
  /** Per-attempt deadline. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Retries after the first attempt for 429, 502-504 and network failures. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A `Retry-After` longer than this fails fast instead of waiting. */
  maxRetryAfterMs?: number;
  maxConcurrent?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface GetOptions {
  signal?: AbortSignal;
  budget?: RequestBudget;
}

export interface ApiResponse {
  endpoint: string;
  status: number;
  /** Parsed JSON body. Validate with a reviewed schema before use. */
  body: unknown;
}

/**
 * Caps the number of HTTP attempts one tool call may make (pagination, joins,
 * retries). The single 401 renew-and-replay is exempt, so an expired token
 * never turns into BUDGET_EXCEEDED.
 */
export class RequestBudget {
  #remaining: number;
  constructor(readonly max: number) {
    this.#remaining = max;
  }
  get remaining(): number {
    return this.#remaining;
  }
  take(endpoint: string): void {
    if (this.#remaining <= 0) {
      throw new SalaryError('BUDGET_EXCEEDED', `Request budget of ${this.max} calls used up.`, {
        endpoint,
        hint: 'Narrow the date range or use a smaller limit.',
      });
    }
    this.#remaining -= 1;
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class Semaphore {
  #free: number;
  #waiters: Array<() => void> = [];
  constructor(size: number) {
    this.#free = size;
  }
  async acquire(): Promise<() => void> {
    if (this.#free > 0) {
      this.#free -= 1;
    } else {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free += 1;
    };
  }
}

function upstreamMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } } | { message?: unknown };
    const msg =
      (parsed as { error?: { message?: unknown } }).error?.message ?? (parsed as { message?: unknown }).message;
    return typeof msg === 'string' ? scrubText(msg).slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

function statusError(status: number, endpoint: string, body: string): SalaryError {
  const detail = upstreamMessage(body);
  const withDetail = (base: string) => (detail ? `${base} Salary said: ${detail}` : base);
  const make = (code: ErrorCode, message: string, hint?: string) =>
    new SalaryError(code, message, { status, endpoint, ...(hint === undefined ? {} : { hint }) });

  if (status === 401) {
    return make('AUTH_REJECTED', 'The Salary API rejected the access token.', 'Run `shine-salary-mcp login` again.');
  }
  if (status === 403) {
    return make(
      'SCOPE_REQUIRED',
      'The API key does not have permission for this data.',
      'Ask a company admin to add the needed read scope to the API key.',
    );
  }
  if (status === 404) return make('NOT_FOUND', withDetail('Not found.'));
  if (status === 400 || status === 422) return make('UPSTREAM_VALIDATION', withDetail('The Salary API rejected the request.'));
  if (status === 429) return make('RATE_LIMITED', 'The Salary API is rate limiting requests.', 'Wait a minute and try again.');
  return make('UPSTREAM_ERROR', withDetail(`The Salary API returned HTTP ${status}.`));
}

/**
 * Read-only client for the Salary API. Callers pass an endpoint identifier and
 * parameters; they cannot choose the method, host or path.
 */
export class SalaryClient {
  readonly #tokens: TokenProvider;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #maxRetryAfterMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #semaphore: Semaphore;

  constructor(opts: SalaryClientOptions) {
    this.#tokens = opts.tokenProvider;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.#maxBytes = opts.maxResponseBytes ?? 5 * 1024 * 1024;
    this.#maxRetries = opts.maxRetries ?? 2;
    this.#baseDelayMs = opts.baseDelayMs ?? 500;
    this.#maxDelayMs = opts.maxDelayMs ?? 8_000;
    this.#maxRetryAfterMs = opts.maxRetryAfterMs ?? 30_000;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#random = opts.random ?? Math.random;
    this.#now = opts.now ?? Date.now;
    this.#semaphore = new Semaphore(opts.maxConcurrent ?? 4);
  }

  async get(endpointId: EndpointId, params: RequestParams = {}, opts: GetOptions = {}): Promise<ApiResponse> {
    // Validation happens before anything else, including token acquisition.
    const { endpoint, url } = buildRequest(endpointId, params);
    const { signal, budget } = opts;

    let replayedAuth = false;
    let retries = 0;
    let skipBudget = false;
    for (;;) {
      if (!skipBudget) budget?.take(endpoint.id);
      skipBudget = false;
      const token = await this.#tokens.getToken(signal);
      let res: Response;
      let text: string;
      const release = await this.#semaphore.acquire();
      try {
        const attemptSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)])
          : AbortSignal.timeout(this.#timeoutMs);
        try {
          res = await this.#fetch(url, {
            method: 'GET',
            redirect: 'error',
            headers: { Authorization: token, Accept: 'application/json', 'User-Agent': USER_AGENT },
            signal: attemptSignal,
          });
          if (isRedirectStatus(res.status)) {
            await res.body?.cancel().catch(() => {});
            throw new SalaryError('REDIRECT_BLOCKED', 'The Salary API answered with a redirect, which is not followed.', {
              status: res.status,
              endpoint: endpoint.id,
            });
          }
          text = await readBodyCapped(res, this.#maxBytes, endpoint.id);
        } catch (err) {
          const mapped = mapFetchError(err, signal, endpoint.id);
          if ((mapped.code === 'NETWORK_ERROR' || mapped.code === 'TIMEOUT') && retries < this.#maxRetries) {
            retries += 1;
            release();
            await this.#sleep(this.#backoff(retries), signal);
            continue;
          }
          throw mapped;
        }
      } finally {
        release();
      }

      if (res.status === 401 && !replayedAuth) {
        replayedAuth = true;
        skipBudget = true;
        this.#tokens.invalidate(token);
        continue;
      }

      if (RETRYABLE_STATUS.has(res.status) && retries < this.#maxRetries) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'), this.#now());
        if (retryAfter === undefined || retryAfter <= this.#maxRetryAfterMs) {
          retries += 1;
          await this.#sleep(retryAfter ?? this.#backoff(retries), signal);
          continue;
        }
      }

      if (res.status < 200 || res.status >= 300) throw statusError(res.status, endpoint.id, text);

      let body: unknown;
      try {
        body = text.length === 0 ? null : JSON.parse(text);
      } catch (err) {
        throw new SalaryError('BAD_RESPONSE', 'The Salary API returned something that is not JSON.', {
          status: res.status,
          endpoint: endpoint.id,
          cause: err,
        });
      }
      return { endpoint: endpoint.id, status: res.status, body };
    }
  }

  /** Full jitter, capped. */
  #backoff(attempt: number): number {
    const ceiling = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(this.#random() * ceiling);
  }
}
