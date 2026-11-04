import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  captureBrowserSession,
  filterStorageState,
  isAllowedLoginRequest,
  TOKEN_COOKIE,
  type BrowserLauncher,
  type Cookie,
  type RoutedRequest,
  type StorageState,
} from '../src/auth/browser-login.js';
import { StoredTokenProvider } from '../src/auth/token-manager.js';
import { loginBrowser, logout, status } from '../src/commands/auth-commands.js';
import { fakeFetch } from './helpers.js';
import { tempRoot, testStoreFactory } from './store-helpers.js';

const TOKEN = `sess-${'q'.repeat(60)}`;
const COMPANY = '0b5e1c2a-3d4f-4a6b-8c7d-9e0f1a2b3c4d';

const cookie = (name: string, value: string, domain = '.salary.dk'): Cookie => ({ name, value, domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Strict' });

/** A fake browser: the "user" finishes login after `loginAfter` cookie polls. */
function fakeBrowser(opts: { loginAfter?: number; closeAfter?: number; extraCookies?: Cookie[]; origins?: StorageState['origins'] } = {}) {
  const seen: { restore?: StorageState; requests: Array<{ url: string; method: string; allowed: boolean }>; closed: boolean; opened?: string } = { requests: [], closed: false };
  let polls = 0;
  let handler: ((r: RoutedRequest) => Promise<void>) | undefined;
  const current = (): Cookie[] => {
    polls += 1;
    const base = [...(opts.extraCookies ?? []), cookie('__cf_bm', 'cf')];
    return opts.loginAfter !== undefined && polls > opts.loginAfter ? [...base, cookie(TOKEN_COOKIE, TOKEN)] : base;
  };
  const launch: BrowserLauncher = async (restore) => {
    if (restore) seen.restore = restore;
    return {
      async open(url) {
        seen.opened = url;
        // The SPA makes these calls during login.
        for (const [method, url] of [
          ['POST', 'https://api.salary.dk/v2/login'],
          ['GET', 'https://api.salary.dk/v2/users'],
          ['GET', 'https://api.salary.dk/v2/paySlips?employeeID=x'],
          ['DELETE', 'https://api.salary.dk/v2/login'],
          ['GET', 'https://challenges.cloudflare.com/turnstile/v0/api.js'],
        ] as const) {
          await handler?.({ url, method, allow: async () => void seen.requests.push({ url, method, allowed: true }), deny: async () => void seen.requests.push({ url, method, allowed: false }) });
        }
      },
      async onApiRequest(h) {
        handler = h;
      },
      cookies: async () => current(),
      storageState: async () => ({ cookies: current(), origins: opts.origins ?? [] }),
      isClosed: () => opts.closeAfter !== undefined && polls >= opts.closeAfter,
      async close() {
        seen.closed = true;
      },
    };
  };
  return { launch, seen };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
}

const salaryApi = (companies = [{ id: COMPANY, name: 'Test ApS' }]) =>
  fakeFetch((call) => {
    if (call.headers.authorization !== TOKEN) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ data: companies }), { status: 200 });
  });

describe('login window request policy', () => {
  it('lets only login POSTs reach the API; other hosts pass', () => {
    expect(isAllowedLoginRequest('https://api.salary.dk/v2/login', 'POST')).toBe(true);
    expect(isAllowedLoginRequest('https://api.salary.dk/v2/login/abc', 'POST')).toBe(true);
    expect(isAllowedLoginRequest('https://api.salary.dk/v2/login', 'DELETE')).toBe(false);
    expect(isAllowedLoginRequest('https://api.salary.dk/v2/users', 'GET')).toBe(false);
    expect(isAllowedLoginRequest('https://api.salary.dk/v2/login/a/b', 'POST')).toBe(false);
    expect(isAllowedLoginRequest('https://login.salary.dk/', 'GET')).toBe(true);
    expect(isAllowedLoginRequest('not a url', 'GET')).toBe(false);
  });
});

describe('filterStorageState', () => {
  it('keeps Salary cookies and localStorage, drops the session token and other sites', () => {
    const out = filterStorageState({
      cookies: [cookie(TOKEN_COOKIE, TOKEN), cookie('device', 'd1'), cookie('other', 'x', '.example.com')],
      origins: [
        { origin: 'https://app.salary.dk', localStorage: [{ name: 'deviceToken', value: 'dev' }, { name: 'accessToken', value: 'leak' }] },
        { origin: 'https://example.com', localStorage: [{ name: 'a', value: 'b' }] },
      ],
    });
    expect(out?.cookies.map((c) => c.name)).toEqual(['device']);
    expect(out?.origins).toEqual([{ origin: 'https://app.salary.dk', localStorage: [{ name: 'deviceToken', value: 'dev' }] }]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('returns nothing when empty or too large', () => {
    expect(filterStorageState({ cookies: [cookie(TOKEN_COOKIE, TOKEN)], origins: [] })).toBeUndefined();
    expect(filterStorageState({ cookies: [cookie('big', 'x'.repeat(5000))], origins: [] }, 1000)).toBeUndefined();
  });
});

describe('captureBrowserSession', () => {
  it('waits for the session cookie, blocks API data calls, and closes the browser', async () => {
    const b = fakeBrowser({ loginAfter: 2 });
    const r = await captureBrowserSession({ launch: b.launch, pollMs: 1, settleMs: 0 });
    expect(r.accessToken).toBe(TOKEN);
    expect(b.seen.opened).toBe('https://app.salary.dk/');
    expect(b.seen.closed).toBe(true);
    expect(b.seen.requests.filter((x) => x.allowed).map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual(['POST /v2/login', 'GET /turnstile/v0/api.js']);
    expect(b.seen.requests.filter((x) => !x.allowed)).toHaveLength(3);
  });

  it('times out cleanly and when the window is closed', async () => {
    const slow = fakeBrowser();
    expect(await codeOf(captureBrowserSession({ launch: slow.launch, pollMs: 1, timeoutMs: 20, settleMs: 0 }))).toBe('AUTH_REQUIRED');
    expect(slow.seen.closed).toBe(true);
    expect(await codeOf(captureBrowserSession({ launch: fakeBrowser({ closeAfter: 2 }).launch, pollMs: 1, settleMs: 0 }))).toBe('AUTH_REQUIRED');
  });
});

describe('loginBrowser', () => {
  const device = [cookie('trusted_device', 'td')];

  it('validates, stores token + device state, writes browser state, and reuses device state next time', async () => {
    const { make, memory } = testStoreFactory(await tempRoot());
    const b = fakeBrowser({ loginAfter: 0, extraCookies: device });
    const { state, companies, rememberedDevice } = await loginBrowser(make(), { fetch: salaryApi().fetch, capture: { launch: b.launch, pollMs: 1, settleMs: 0 } });
    expect(state.mode).toBe('browser');
    expect(state.companyID).toBe(COMPANY);
    expect(companies).toHaveLength(1);
    expect(rememberedDevice).toBe(true);
    expect(memory.data.get('browser-state')).toContain('trusted_device');
    expect(memory.data.get('browser-state')).not.toContain(TOKEN);
    expect(JSON.parse(memory.data.get('credentials')!)).toEqual({ v: 1, mode: 'browser', generation: state.generation });

    const again = fakeBrowser({ loginAfter: 0 });
    await loginBrowser(make(), { fetch: salaryApi().fetch, capture: { launch: again.launch, pollMs: 1, settleMs: 0 } });
    expect(again.seen.restore?.cookies.map((c) => c.name)).toContain('trusted_device');
  });

  it('stores nothing if the captured session does not validate', async () => {
    const { make, memory } = testStoreFactory(await tempRoot());
    const bad = fakeFetch(() => new Response('{}', { status: 401 }));
    expect(await codeOf(loginBrowser(make(), { fetch: bad.fetch, capture: { launch: fakeBrowser({ loginAfter: 0 }).launch, pollMs: 1, settleMs: 0 } }))).toBe('AUTH_REJECTED');
    expect(memory.data.size).toBe(0);
    expect(await make().readState()).toBeUndefined();
  });

  it('leaves company unset when the session sees several companies', async () => {
    const { make } = testStoreFactory(await tempRoot());
    const two = [{ id: COMPANY, name: 'A' }, { id: '0b6e2c1a-1111-4222-8333-444455556666', name: 'B' }];
    const { state } = await loginBrowser(make(), { fetch: salaryApi(two).fetch, capture: { launch: fakeBrowser({ loginAfter: 0 }).launch, pollMs: 1, settleMs: 0 } });
    expect(state.companyID).toBeNull();
    expect(state.companies).toHaveLength(2);
  });

  it('browser tokens are used past their nominal hour, never exchanged, and need a person once rejected', async () => {
    const { make } = testStoreFactory(await tempRoot());
    await loginBrowser(make(), { fetch: salaryApi().fetch, capture: { launch: fakeBrowser({ loginAfter: 0 }).launch, pollMs: 1, settleMs: 0 } });
    let exchanged = 0;
    const later = Date.now() + 5 * 60 * 60 * 1000;
    const p = new StoredTokenProvider(make(), { now: () => later, exchange: async () => ((exchanged += 1), Promise.reject(new Error('no'))) });
    expect(await p.getToken()).toBe(TOKEN);
    p.invalidate(TOKEN);
    const err = await codeOf(p.getToken());
    expect(err).toBe('AUTH_REQUIRED');
    expect(exchanged).toBe(0);
    // The rejection age is recorded as the token-lifetime probe.
    const st = await make().readState();
    expect(st?.tokenRejectedAfterMs).toBeGreaterThan(4 * 60 * 60 * 1000);
    expect((await status(make())).state?.mode).toBe('browser');
  });

  it('logout removes token, credentials and browser state', async () => {
    const { make, memory } = testStoreFactory(await tempRoot());
    await loginBrowser(make(), { fetch: salaryApi().fetch, capture: { launch: fakeBrowser({ loginAfter: 0, extraCookies: device }).launch, pollMs: 1, settleMs: 0 } });
    expect(memory.data.size).toBe(3);
    await logout(make());
    expect(memory.data.size).toBe(0);
  });
});

describe('state compatibility', () => {
  it('a state.json written before browser mode still parses as API mode', async () => {
    const { ProfileState } = await import('../src/auth/store.js');
    const old = {
      version: 1,
      profile: 'default',
      backend: 'wsl-dpapi',
      generation: '6f1c2c55-7a7e-4b8e-9d55-2f6a1f0d2c11',
      companyID: COMPANY,
      companyName: 'Test ApS',
      scopes: ['ReadAll'],
      createdAt: '2026-11-04T18:00:00.000Z',
    };
    expect(ProfileState.parse(old).mode).toBe('api');
  });
});

describe('serve cannot open a browser', () => {
  it('has no import path from server.ts to the browser login or Playwright', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/playwright/);
      for (const m of text.matchAll(/from '(\.[^']+)\.js'/g)) visit(resolve(dirname(file), `${m[1]}.ts`));
    };
    visit(join(root, 'server.ts'));
    expect([...seen].some((f) => f.includes('browser-login'))).toBe(false);
    expect(seen.size).toBeGreaterThan(10);
  });
});
