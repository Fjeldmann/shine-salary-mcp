import { describe, expect, it } from 'vitest';
import { ApiCredentialTokenProvider, exchangeApiCredentials } from '../src/auth/api-client.js';
import { readDevEnvCredentials } from '../src/auth/env-credentials.js';
import { fakeFetch, json } from './helpers.js';

const creds = {
  apiClientID: '9d3b4c5e-0000-4000-8000-000000000001',
  apiClientSecret: 's'.repeat(255),
  apiKey: 'k'.repeat(256),
};
const TOKEN = 'a'.repeat(256);

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string; hint?: string };
  }
  throw new Error('expected rejection');
}

describe('exchangeApiCredentials', () => {
  it('POSTs exactly the three fields to /v2/auth on the fixed origin', async () => {
    const f = fakeFetch(json(200, { data: { accessToken: TOKEN } }));
    const t = await exchangeApiCredentials(creds, { fetch: f.fetch, now: () => 1000 });
    expect(t.accessToken).toBe(TOKEN);
    expect(t.expiresAt).toBeGreaterThan(1000);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.salary.dk/v2/auth');
    expect(call.method).toBe('POST');
    expect(call.redirect).toBe('error');
    expect(call.headers.authorization).toBeUndefined();
    expect(Object.keys(JSON.parse(call.body!)).sort()).toEqual(['apiClientID', 'apiClientSecret', 'apiKey']);
  });

  it('maps 404 "API Client not found" to a client-ID hint', async () => {
    const f = fakeFetch(json(404, { error: { message: 'API Client not found', type: 'NotFound' } }));
    const err = await errorOf(exchangeApiCredentials(creds, { fetch: f.fetch }));
    expect(err.code).toBe('CREDENTIALS_REJECTED');
    expect(err.hint).toMatch(/client ID/);
  });

  it('maps 401 to CREDENTIALS_REJECTED without echoing secrets', async () => {
    const f = fakeFetch(json(401, { error: { message: `bad ${creds.apiKey}` } }));
    const err = await errorOf(exchangeApiCredentials(creds, { fetch: f.fetch }));
    expect(err.code).toBe('CREDENTIALS_REJECTED');
    expect(JSON.stringify(err) + err.message).not.toContain(creds.apiKey);
  });

  it('rejects a malformed client ID before any request', async () => {
    const f = fakeFetch(json(200, {}));
    expect((await errorOf(exchangeApiCredentials({ ...creds, apiClientID: 'abc' }, { fetch: f.fetch }))).code).toBe('CREDENTIALS_REJECTED');
    expect(f.calls).toHaveLength(0);
  });

  it('refuses redirects and unusable tokens', async () => {
    const r = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
    expect((await errorOf(exchangeApiCredentials(creds, { fetch: r.fetch }))).code).toBe('REDIRECT_BLOCKED');
    for (const body of [{ data: {} }, { data: { accessToken: 'short' } }, { data: { accessToken: 'has space'.repeat(4) } }]) {
      const f = fakeFetch(json(200, body));
      expect((await errorOf(exchangeApiCredentials(creds, { fetch: f.fetch }))).code).toBe('BAD_RESPONSE');
    }
  });
});

describe('ApiCredentialTokenProvider', () => {
  it('shares one exchange between concurrent callers and caches the token', async () => {
    const f = fakeFetch(json(200, { data: { accessToken: TOKEN } }));
    const p = new ApiCredentialTokenProvider(creds, { fetch: f.fetch });
    const tokens = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    await p.getToken();
    expect(new Set(tokens)).toEqual(new Set([TOKEN]));
    expect(f.calls).toHaveLength(1);
  });

  it('renews after invalidate and near expiry, but ignores a stale invalidate', async () => {
    let n = 0;
    const f = fakeFetch(() => new Response(JSON.stringify({ data: { accessToken: `${String(++n)}${'b'.repeat(40)}` } }), { status: 200 }));
    let now = 0;
    const p = new ApiCredentialTokenProvider(creds, { fetch: f.fetch, now: () => now });
    const first = await p.getToken();
    p.invalidate('something-else');
    expect(await p.getToken()).toBe(first);
    p.invalidate(first);
    const second = await p.getToken();
    expect(second).not.toBe(first);
    now = 49 * 60 * 1000; // inside the safety margin of the assumed 50-minute lifetime
    expect(await p.getToken()).not.toBe(second);
    expect(f.calls).toHaveLength(3);
  });
});

it('keeps the token when the only waiting caller is cancelled', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fakeFetch(async () => {
    await gate;
    return new Response(JSON.stringify({ data: { accessToken: TOKEN } }), { status: 200 });
  });
  const p = new ApiCredentialTokenProvider(creds, { fetch: f.fetch });
  const ctl = new AbortController();
  const waiting = p.getToken(ctl.signal);
  ctl.abort();
  expect((await errorOf(waiting)).code).toBe('CANCELLED');
  release();
  await new Promise((r) => setTimeout(r, 10));
  expect(await p.getToken()).toBe(TOKEN);
  expect(f.calls).toHaveLength(1);
});

describe('dev env credentials', () => {
  const env = { 'API-CLIENT-ID': creds.apiClientID, 'API-CLIENT-SECRET': creds.apiClientSecret, 'API-KEY': creds.apiKey };

  it('are off unless explicitly enabled', () => {
    expect(() => readDevEnvCredentials(env)).toThrow(/No credentials/);
  });

  it('read the .env.example variable names when enabled', () => {
    expect(readDevEnvCredentials({ ...env, SHINE_SALARY_DEV_ENV_CREDENTIALS: '1' })).toEqual(creds);
  });

  it('name the missing variables', () => {
    expect(() => readDevEnvCredentials({ SHINE_SALARY_DEV_ENV_CREDENTIALS: '1', 'API-KEY': 'x' })).toThrow(/API-CLIENT-ID, API-CLIENT-SECRET/);
  });
});
