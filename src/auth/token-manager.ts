import type { TokenProvider } from '../api/client.js';
import { SalaryError } from '../errors.js';
import { registerSecret } from '../log.js';
import { exchangeApiCredentials, type AccessToken, type ApiCredentials, type ExchangeOptions } from './api-client.js';
import { CredentialsRecord, parseRecord, TokenRecord, type ProfileStore } from './store.js';

export type Exchange = (creds: ApiCredentials, opts: ExchangeOptions) => Promise<AccessToken>;

export interface StoredTokenProviderOptions {
  exchange?: Exchange;
  exchangeOptions?: ExchangeOptions;
  now?: () => number;
  safetyMarginMs?: number;
}

const notLoggedIn = () =>
  new SalaryError('AUTH_REQUIRED', 'Not logged in to Salary.', { hint: 'Run `shine-salary-mcp login` in a terminal.' });

/**
 * Tokens backed by the profile store, shared between processes.
 *
 * - In process: single-flight renewal.
 * - Across processes: renewal happens under the profile lock, and the stored
 *   token is reread after acquiring it, so concurrent servers exchange once.
 * - Logout and re-login: every call reads the non-secret state file; a missing
 *   file or a new generation drops the cached token before any request.
 */
export class StoredTokenProvider implements TokenProvider {
  readonly #store: ProfileStore;
  readonly #exchange: Exchange;
  readonly #exchangeOpts: ExchangeOptions;
  readonly #now: () => number;
  readonly #marginMs: number;
  /** Tokens the API rejected; a reread must not hand them back. */
  readonly #rejected = new Set<string>();
  #current: TokenRecord | undefined;
  #pending: Promise<TokenRecord> | undefined;

  constructor(store: ProfileStore, opts: StoredTokenProviderOptions = {}) {
    this.#store = store;
    this.#exchange = opts.exchange ?? exchangeApiCredentials;
    this.#exchangeOpts = opts.exchangeOptions ?? {};
    this.#now = opts.now ?? Date.now;
    this.#marginMs = opts.safetyMarginMs ?? 2 * 60 * 1000;
  }

  /** Browser tokens have no known lifetime: they are used until Salary rejects one. */
  #usable(t: TokenRecord | undefined, generation: string, mode: 'api' | 'browser'): boolean {
    if (!t || t.generation !== generation || this.#rejected.has(t.accessToken)) return false;
    return mode === 'browser' || t.expiresAt - this.#marginMs > this.#now();
  }

  async getToken(): Promise<string> {
    const state = await this.#store.readState();
    if (!state) {
      this.#current = undefined;
      throw notLoggedIn();
    }
    if (this.#current && this.#usable(this.#current, state.generation, state.mode)) return this.#current.accessToken;
    this.#current = undefined;

    this.#pending ??= this.#renew(state.generation).finally(() => {
      this.#pending = undefined;
    });
    return (await this.#pending).accessToken;
  }

  invalidate(token: string): void {
    this.#rejected.add(token);
    if (this.#rejected.size > 16) this.#rejected.delete(this.#rejected.values().next().value as string);
    if (this.#current?.accessToken === token) this.#current = undefined;
  }

  async #renew(generation: string): Promise<TokenRecord> {
    return this.#store.lock(async () => {
      const state = await this.#store.readState();
      if (!state || state.generation !== generation) throw notLoggedIn();
      const backend = await this.#store.backend(state.backend);

      const stored = parseRecord(TokenRecord, await backend.get('token'), 'access token');
      if (stored && this.#usable(stored, generation, state.mode)) {
        registerSecret(stored.accessToken);
        this.#current = stored;
        return stored;
      }

      const creds = parseRecord(CredentialsRecord, await backend.get('credentials'), 'credentials');
      if (!creds || creds.generation !== generation) throw notLoggedIn();
      if (creds.mode === 'browser') {
        // No way to renew without a person. Record how long the session lasted, once.
        if (stored && this.#rejected.has(stored.accessToken) && state.tokenRejectedAfterMs === undefined) {
          await this.#store.writeState({ ...state, tokenRejectedAfterMs: this.#now() - stored.obtainedAt });
        }
        throw new SalaryError('AUTH_REQUIRED', 'The Salary browser session has expired.', {
          hint: 'Run `shine-salary-mcp login --method browser` in a terminal.',
        });
      }
      registerSecret(creds.apiClientSecret);
      registerSecret(creds.apiKey);

      const fresh = await this.#exchange(
        { apiClientID: creds.apiClientID, apiClientSecret: creds.apiClientSecret, apiKey: creds.apiKey },
        this.#exchangeOpts,
      );
      registerSecret(fresh.accessToken);
      const record: TokenRecord = { v: 1, generation, accessToken: fresh.accessToken, obtainedAt: fresh.obtainedAt, expiresAt: fresh.expiresAt };
      await backend.set('token', JSON.stringify(record));
      this.#current = record;
      return record;
    });
  }
}
