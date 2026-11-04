import { describe, expect, it } from 'vitest';
import type { ApiCredentials } from '../src/auth/api-client.js';
import { StoredTokenProvider, type Exchange } from '../src/auth/token-manager.js';
import { login, logout, status } from '../src/commands/auth-commands.js';
import type { Call } from './helpers.js';
import { fakeFetch } from './helpers.js';
import { tempRoot, testStoreFactory } from './store-helpers.js';

const COMPANY = '0b5e1c2a-3d4f-4a6b-8c7d-9e0f1a2b3c4d';
const creds: ApiCredentials = { apiClientID: '9d3b4c5e-0000-4000-8000-000000000001', apiClientSecret: 'secret-'.repeat(10), apiKey: 'apikey-'.repeat(10) };

/** Salary double: /v2/auth issues numbered tokens; GETs return one company and the key's scopes. */
function salary(scopes: string[] = ['ReadAll'], companies = [{ id: COMPANY, name: 'Test ApS' }]) {
  let issued = 0;
  const f = fakeFetch((call: Call) => {
    const path = new URL(call.url).pathname;
    if (path === '/v2/auth') {
      issued += 1;
      return new Response(JSON.stringify({ data: { accessToken: `token-${String(issued).padStart(3, '0')}-${'x'.repeat(30)}` } }), { status: 200 });
    }
    if (path === '/v2/companies') return new Response(JSON.stringify({ data: companies }), { status: 200 });
    if (path === '/v2/apiKeys') return new Response(JSON.stringify({ data: [{ id: 'k1', companyID: COMPANY, description: 'mcp', scopes }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  return { ...f, issued: () => issued };
}

function countingExchange(now: () => number = Date.now): { exchange: Exchange; count: () => number } {
  let n = 0;
  return {
    exchange: async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { accessToken: `renewed-${n}-${'y'.repeat(30)}`, obtainedAt: now(), expiresAt: now() + 50 * 60_000 };
    },
    count: () => n,
  };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
}

describe('login', () => {
  it('verifies, stores in the first available backend and writes state last', async () => {
    const { make, memory } = testStoreFactory(await tempRoot());
    const api = salary();
    const { state } = await login(make(), creds, { fetch: api.fetch });
    expect(state.backend).toBe('keyring');
    expect(state.companyName).toBe('Test ApS');
    expect(state.scopes).toEqual(['ReadAll']);
    expect(JSON.parse(memory.data.get('credentials')!)).toMatchObject({ generation: state.generation, apiKey: creds.apiKey });
    expect(api.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /v2/auth', 'GET /v2/companies', 'GET /v2/apiKeys']);
  });

  it('refuses a key that is not provably read-only and stores nothing', async () => {
    const { make, memory } = testStoreFactory(await tempRoot());
    const store = make();
    expect(await codeOf(login(store, creds, { fetch: salary(['ReadAll', 'WriteAll']).fetch }))).toBe('SCOPE_NOT_READ_ONLY');
    expect(memory.data.size).toBe(0);
    expect(await store.readState()).toBeUndefined();
  });

  it('refuses keys that see zero or several companies', async () => {
    const { make } = testStoreFactory(await tempRoot());
    const two = [{ id: COMPANY, name: 'A' }, { id: '0b6e2c1a-1111-4222-8333-444455556666', name: 'B' }];
    expect(await codeOf(login(make(), creds, { fetch: salary(['ReadAll'], two).fetch }))).toBe('INVALID_PARAMS');
    // No company at all means no key to inspect, so read-only cannot be shown.
    expect(await codeOf(login(make(), creds, { fetch: salary(['ReadAll'], []).fetch }))).toBe('SCOPE_NOT_READ_ONLY');
  });

  it('can use the encrypted-file backend and a re-login replaces the generation', async () => {
    const { make } = testStoreFactory(await tempRoot());
    const store = make();
    const first = await login(store, creds, { fetch: salary().fetch, backend: 'wsl-dpapi' });
    expect((await status(store)).credentialsReadable).toBe(true);
    const second = await login(store, creds, { fetch: salary().fetch, backend: 'wsl-dpapi' });
    expect(second.state.generation).not.toBe(first.state.generation);
    expect((await status(store)).credentialsReadable).toBe(true);
  });
});

describe('StoredTokenProvider', () => {
  it('a new process reuses the stored token without exchanging (restart)', async () => {
    const { make } = testStoreFactory(await tempRoot());
    const api = salary();
    await login(make(), creds, { fetch: api.fetch });
    const ex = countingExchange();
    const token = await new StoredTokenProvider(make(), { exchange: ex.exchange }).getToken();
    expect(token).toMatch(/^token-001/);
    expect(ex.count()).toBe(0);
  });

  it('concurrent providers (separate processes) renew with one exchange', async () => {
    const { make } = testStoreFactory(await tempRoot());
    await login(make(), creds, { fetch: salary().fetch });
    const later = Date.now() + 60 * 60_000; // stored token has expired for everyone
    const ex = countingExchange(() => later);
    const providers = [1, 2, 3].map(() => new StoredTokenProvider(make(), { exchange: ex.exchange, now: () => later }));
    const tokens = await Promise.all(providers.flatMap((p) => [p.getToken(), p.getToken()]));
    expect(ex.count()).toBe(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it('after invalidate, the reread does not hand back the rejected token', async () => {
    const { make } = testStoreFactory(await tempRoot());
    await login(make(), creds, { fetch: salary().fetch });
    const ex = countingExchange();
    const p = new StoredTokenProvider(make(), { exchange: ex.exchange });
    const first = await p.getToken();
    p.invalidate(first);
    const second = await p.getToken();
    expect(second).not.toBe(first);
    expect(ex.count()).toBe(1);
    // Another process now picks up the renewed token from the store.
    expect(await new StoredTokenProvider(make(), { exchange: ex.exchange }).getToken()).toBe(second);
  });

  it('logout reaches a running process before its next request', async () => {
    const { make } = testStoreFactory(await tempRoot());
    await login(make(), creds, { fetch: salary().fetch });
    const p = new StoredTokenProvider(make(), { exchange: countingExchange().exchange });
    await p.getToken();
    expect(await logout(make())).toBe(true);
    expect(await codeOf(p.getToken())).toBe('AUTH_REQUIRED');
  });

  it('a re-login (new generation) replaces the cached token in running processes', async () => {
    const { make } = testStoreFactory(await tempRoot());
    await login(make(), creds, { fetch: salary().fetch });
    const p = new StoredTokenProvider(make(), { exchange: countingExchange().exchange });
    const before = await p.getToken();
    const api2 = salary();
    // Fresh issuer so tokens differ.
    await api2.fetch(new URL('https://api.salary.dk/v2/auth'), { method: 'POST' });
    await login(make(), creds, { fetch: api2.fetch });
    expect(await p.getToken()).not.toBe(before);
  });

  it('logout waits for an in-flight renewal, then removes what it wrote', async () => {
    const { make, memory } = testStoreFactory(await tempRoot());
    await login(make(), creds, { fetch: salary().fetch });
    let release!: () => void;
    let started!: () => void;
    const exchangeStarted = new Promise<void>((r) => (started = r));
    const slow: Exchange = async () => {
      const gate = new Promise<void>((r) => (release = r));
      started();
      await gate;
      return { accessToken: `late-${'z'.repeat(30)}`, obtainedAt: Date.now(), expiresAt: Date.now() + 3_000_000 };
    };
    const p = new StoredTokenProvider(make(), { exchange: slow, now: () => Date.now() + 60 * 60_000 });
    const pending = p.getToken();
    await exchangeStarted; // renewal now holds the lock
    const out = logout(make()); // waits for the lock held by the renewal
    await new Promise((r) => setTimeout(r, 30));
    release();
    await pending;
    await out;
    expect(memory.data.size).toBe(0);
    expect(await codeOf(p.getToken())).toBe('AUTH_REQUIRED');
  });

  it('reports AUTH_REQUIRED when never logged in', async () => {
    const { make } = testStoreFactory(await tempRoot());
    expect(await codeOf(new StoredTokenProvider(make()).getToken())).toBe('AUTH_REQUIRED');
  });
});

describe('logout and status', () => {
  it('logout clears every backend file and is idempotent', async () => {
    const root = await tempRoot();
    const { make, keys } = testStoreFactory(root);
    await login(make(), creds, { fetch: salary().fetch, backend: 'wsl-dpapi' });
    expect(await logout(make())).toBe(true);
    expect(keys.key).toBeUndefined();
    expect(await logout(make())).toBe(false);
    expect((await status(make())).configured).toBe(false);
  });

  it('status reports a damaged store without throwing', async () => {
    const { make, keys } = testStoreFactory(await tempRoot());
    await login(make(), creds, { fetch: salary().fetch, backend: 'wsl-dpapi' });
    await keys.create(); // key no longer matches the files
    const st = await status(make());
    expect(st.configured).toBe(true);
    expect(st.credentialsReadable).toBe(false);
    expect(st.storeError).toMatch(/STORE_CORRUPT/);
  });
});
