import type { FetchLike } from '../api/http.js';
import { exchangeApiCredentials, type ApiCredentials } from '../auth/api-client.js';
import { EncryptedFileBackend } from '../auth/backends/encrypted-file.js';
import { BACKEND_KINDS, type BackendKind } from '../auth/backends/types.js';
import { CredentialsRecord, parseRecord, TokenRecord, type ProfileState, type ProfileStore } from '../auth/store.js';
import { StoredTokenProvider } from '../auth/token-manager.js';
import { SalaryError } from '../errors.js';
import { registerSecret } from '../log.js';
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
      scopes: [...new Set(report.keys.flatMap((k) => k.scopes))],
    });
    return { state, report };
  });
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
      ...(token && token.generation === state.generation ? { tokenExpiresAt: token.expiresAt } : {}),
    };
  } catch (err) {
    return { configured: true, state, credentialsReadable: false, storeError: err instanceof SalaryError ? `${err.code}: ${err.message}` : 'unreadable' };
  }
}

export async function checkStored(store: ProfileStore, opts: { fetch?: FetchLike } = {}): Promise<AccessReport> {
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  return checkAccess(new StoredTokenProvider(store, { exchangeOptions: fetchOpt }), fetchOpt);
}
