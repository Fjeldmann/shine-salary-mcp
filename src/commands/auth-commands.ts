import { SalaryClient } from '../api/client.js';
import type { FetchLike } from '../api/http.js';
import { CompaniesResponse, parseResponse } from '../api/schemas.js';
import { captureBrowserSession, type CaptureOptions, type StorageState } from '../auth/browser-login.js';
import { exchangeApiCredentials, type ApiCredentials } from '../auth/api-client.js';
import { EncryptedFileBackend } from '../auth/backends/encrypted-file.js';
import { BACKEND_KINDS, type BackendKind } from '../auth/backends/types.js';
import { CredentialsRecord, parseRecord, TokenRecord, type ProfileState, type ProfileStore } from '../auth/store.js';
import { StoredTokenProvider } from '../auth/token-manager.js';
import { SalaryError } from '../errors.js';
import { log, registerSecret } from '../log.js';
import { checkAccess, type AccessReport } from './check-access.js';

export type BackendChoice = BackendKind | 'auto';

export interface LoginOptions {
  backend?: BackendChoice;
  fetch?: FetchLike;
}

export interface LoginResult {
  state: ProfileState;
  report: AccessReport;
}

async function chooseBackend(store: ProfileStore, choice: BackendChoice): Promise<BackendKind> {
  const available = await store.availableBackends();
  if (choice !== 'auto') {
    if (!available.includes(choice)) {
      throw new SalaryError('STORE_UNAVAILABLE', `The "${choice}" credential store does not work on this machine.`, {
        hint: available.length ? `Available here: ${available.join(', ')}.` : 'No secure store is available here.',
      });
    }
    return choice;
  }
  const first = available[0];
  if (!first) {
    throw new SalaryError('STORE_UNAVAILABLE', 'No secure credential store is available on this machine.', {
      hint: `Supported: ${BACKEND_KINDS.join(', ')}. On Linux install and unlock a Secret Service (gnome-keyring); on WSL make sure powershell.exe can run.`,
    });
  }
  return first;
}

/**
 * Validate the credentials against Salary (login + GETs), refuse anything
 * not provably read-only, then store them. The state file is written last,
 * so an interrupted login leaves the profile logged out.
 */
export async function login(store: ProfileStore, creds: ApiCredentials, opts: LoginOptions = {}): Promise<LoginResult> {
  registerSecret(creds.apiClientSecret);
  registerSecret(creds.apiKey);
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};

  const token = await exchangeApiCredentials(creds, fetchOpt);
  registerSecret(token.accessToken);
  const report = await checkAccess({ getToken: async () => token.accessToken, invalidate: () => {} }, fetchOpt);

  if (!report.readOnly) {
    const scopes = report.keys.map((k) => k.scopes.join('+') || '(none)').join(', ');
    throw new SalaryError('SCOPE_NOT_READ_ONLY', `The API key is not confirmed read-only (scopes: ${scopes}).`, {
      hint: 'Create a company API key with only "Fuld læseadgang" in Salary and log in with that key.',
    });
  }
  const [company, ...others] = report.companies;
  if (!company || others.length > 0) {
    throw new SalaryError('INVALID_PARAMS', `Expected the API key to give access to exactly one company, found ${report.companies.length}.`);
  }

  const kind = await chooseBackend(store, opts.backend ?? 'auto');

  return store.lock(async () => {
    const previous = await store.readState().catch(() => undefined);
    // Logged-out first, so a process that reads state mid-login sees "not logged in".
    await store.deleteState();
    if (previous) await (await store.backend(previous.backend)).destroy().catch(() => {});

    const backend = await store.backend(kind);
    if (backend instanceof EncryptedFileBackend) await backend.prepare();
    const generation = crypto.randomUUID();
    const credsRecord: CredentialsRecord = { v: 1, mode: 'api', generation, ...creds };
    await backend.set('credentials', JSON.stringify(credsRecord));
    const tokenRecord: TokenRecord = { v: 1, generation, ...token };
    await backend.set('token', JSON.stringify(tokenRecord));

    const state = await store.writeState({
      backend: kind,
      generation,
      companyID: company.id,
      companyName: company.name,
      companies: [{ id: company.id, name: company.name }],
      scopes: [...new Set(report.keys.flatMap((k) => k.scopes))],
    });
    return { state, report };
  });
}

export interface BrowserLoginOptions {
  backend?: BackendChoice;
  fetch?: FetchLike;
  capture?: CaptureOptions;
}

/**
 * Browser login: a person signs in to app.salary.dk; we keep the session token.
 * That token carries the user's full Salary permissions, so read-only is then
 * enforced by this client only. The CLI asks for explicit acceptance first.
 */
export async function loginBrowser(store: ProfileStore, opts: BrowserLoginOptions = {}): Promise<{ state: ProfileState; companies: AuthorizedCompanyLite[]; rememberedDevice: boolean }> {
  const kind = await chooseBackend(store, opts.backend ?? 'auto');

  // Restore "trust this device" state from a previous browser login, if any.
  let restore: StorageState | undefined;
  try {
    const previous = await store.readState();
    if (previous?.mode === 'browser') {
      const raw = await (await store.backend(previous.backend)).get('browser-state');
      restore = raw ? (JSON.parse(raw) as StorageState) : undefined;
    }
  } catch {
    restore = undefined;
  }

  const captured = await captureBrowserSession({ ...opts.capture, restore });
  registerSecret(captured.accessToken);

  // Validate with our own read-only client before storing anything.
  const client = new SalaryClient({
    tokenProvider: { getToken: async () => captured.accessToken, invalidate: () => {} },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const res = await client.get('companies.list', { query: { limit: 100 } });
  const companies = parseResponse(CompaniesResponse, res.body, 'companies.list').data.map((c) => ({ id: c.id, name: c.name }));
  if (companies.length === 0) throw new SalaryError('INVALID_PARAMS', 'The Salary session does not have access to any company.');

  return store.lock(async () => {
    const previous = await store.readState().catch(() => undefined);
    await store.deleteState();
    if (previous) await (await store.backend(previous.backend)).destroy().catch(() => {});

    const backend = await store.backend(kind);
    if (backend instanceof EncryptedFileBackend) await backend.prepare();
    const generation = crypto.randomUUID();
    const now = Date.now();
    await backend.set('credentials', JSON.stringify({ v: 1, mode: 'browser', generation } satisfies CredentialsRecord));
    // expiresAt is informational only: browser tokens are used until Salary rejects them.
    const tokenRecord: TokenRecord = { v: 1, generation, accessToken: captured.accessToken, obtainedAt: now, expiresAt: now + 60 * 60 * 1000 };
    await backend.set('token', JSON.stringify(tokenRecord));
    let rememberedDevice = false;
    if (captured.browserState) {
      try {
        await backend.set('browser-state', JSON.stringify(captured.browserState));
        rememberedDevice = true;
      } catch (err) {
        log('warn', 'browser login: trusted-device state not saved', { code: (err as { code?: string }).code ?? 'unknown' });
      }
    }
    const only = companies.length === 1 ? companies[0] : undefined;
    const state = await store.writeState({
      backend: kind,
      generation,
      mode: 'browser',
      companyID: only?.id ?? null,
      companyName: only?.name ?? null,
      companies,
      scopes: [],
    });
    return { state, companies, rememberedDevice };
  });
}

export interface AuthorizedCompanyLite {
  id: string;
  name: string;
}

/** Delete local credentials, token, key and state. Returns whether anything was configured. */
export async function logout(store: ProfileStore): Promise<boolean> {
  return store.lock(async () => {
    let state: ProfileState | undefined;
    try {
      state = await store.readState();
    } catch {
      state = undefined; // damaged state: still clean up below
    }
    await store.deleteState();
    const kinds = state ? [state.backend] : [...BACKEND_KINDS];
    for (const kind of kinds) {
      try {
        await (await store.backend(kind)).destroy();
      } catch (err) {
        if (state) throw err; // the configured backend must be cleaned; others are best effort
      }
    }
    return state !== undefined;
  });
}

export interface StatusReport {
  configured: boolean;
  state?: ProfileState;
  tokenExpiresAt?: number;
  tokenObtainedAt?: number;
  credentialsReadable?: boolean;
  storeError?: string;
}

/** Offline status: reads local state and secrets, no network. */
export async function status(store: ProfileStore): Promise<StatusReport> {
  const state = await store.readState();
  if (!state) return { configured: false };
  try {
    const backend = await store.backend(state.backend);
    const creds = parseRecord(CredentialsRecord, await backend.get('credentials'), 'credentials');
    const token = parseRecord(TokenRecord, await backend.get('token'), 'access token');
    return {
      configured: true,
      state,
      credentialsReadable: creds?.generation === state.generation,
      ...(token && token.generation === state.generation ? { tokenExpiresAt: token.expiresAt, tokenObtainedAt: token.obtainedAt } : {}),
    };
  } catch (err) {
    return { configured: true, state, credentialsReadable: false, storeError: err instanceof SalaryError ? `${err.code}: ${err.message}` : 'unreadable' };
  }
}

/** Browser mode check: the session can list companies (GET only). */
export async function checkStoredCompanies(store: ProfileStore, opts: { fetch?: FetchLike } = {}): Promise<AuthorizedCompanyLite[]> {
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  const client = new SalaryClient({ tokenProvider: new StoredTokenProvider(store), ...fetchOpt });
  const res = await client.get('companies.list', { query: { limit: 100 } });
  return parseResponse(CompaniesResponse, res.body, 'companies.list').data.map((c) => ({ id: c.id, name: c.name }));
}

export async function checkStored(store: ProfileStore, opts: { fetch?: FetchLike } = {}): Promise<AccessReport> {
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  return checkAccess(new StoredTokenProvider(store, { exchangeOptions: fetchOpt }), fetchOpt);
}
