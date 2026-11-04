import { SalaryError } from '../errors.js';
import { log } from '../log.js';

/**
 * Interactive browser login (PLAN §6 "Browser bootstrap"). Only the `login`
 * command reaches this module; `serve` never imports it, so a server can
 * never open a browser.
 *
 * The person signs in to app.salary.dk in a visible browser and completes
 * Turnstile and MFA themselves. We wait for the `sally_access_token` session
 * cookie, then close the browser. While the window is open, every API call
 * except the login itself is answered locally with 401, so no payroll data
 * is loaded into the browser.
 */

export const APP_URL = 'https://app.salary.dk/';
export const TOKEN_COOKIE = 'sally_access_token';
const API_HOST = 'api.salary.dk';

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}
export interface StorageState {
  cookies: Cookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface RoutedRequest {
  url: string;
  method: string;
  allow(): Promise<void>;
  deny(): Promise<void>;
}

/** The parts of a Playwright browser context the login flow uses (injectable for tests). */
export interface BrowserSession {
  open(url: string): Promise<void>;
  onApiRequest(handler: (req: RoutedRequest) => Promise<void>): Promise<void>;
  cookies(): Promise<Cookie[]>;
  storageState(): Promise<StorageState>;
  isClosed(): boolean;
  close(): Promise<void>;
}
export type BrowserLauncher = (restore?: StorageState) => Promise<BrowserSession>;

/** Only the login calls may reach Salary from the login window, and only as POST. */
export function isAllowedLoginRequest(url: string, method: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname !== API_HOST) return true; // other hosts (login page, Turnstile) are not intercepted
  const loginPath = u.pathname === '/v2/login' || /^\/v2\/login\/[^/]+$/.test(u.pathname);
  return loginPath && (method === 'POST' || method === 'OPTIONS');
}

const isSalaryDomain = (domain: string) => /(^|\.)salary\.dk$/i.test(domain.replace(/^\./, ''));

/**
 * Keep only what restores "trust this device" on the next login: Salary
 * cookies and localStorage, never the session token itself.
 */
export function filterStorageState(state: StorageState, maxBytes = 16 * 1024): StorageState | undefined {
  const filtered: StorageState = {
    cookies: state.cookies.filter((c) => isSalaryDomain(c.domain) && c.name !== TOKEN_COOKIE),
    origins: state.origins
      .filter((o) => {
        try {
          return isSalaryDomain(new URL(o.origin).hostname);
        } catch {
          return false;
        }
      })
      .map((o) => ({ origin: o.origin, localStorage: o.localStorage.filter((i) => !/access.?token|csrf|session/i.test(i.name)) })),
  };
  if (filtered.cookies.length === 0 && filtered.origins.every((o) => o.localStorage.length === 0)) return undefined;
  return JSON.stringify(filtered).length <= maxBytes ? filtered : undefined;
}

export interface CaptureOptions {
  launch?: BrowserLauncher;
  restore?: StorageState | undefined;
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
}

export interface CaptureResult {
  accessToken: string;
  browserState: StorageState | undefined;
}

/** Open the login window, wait for the session cookie, close the window. */
export async function captureBrowserSession(opts: CaptureOptions = {}): Promise<CaptureResult> {
  const launch = opts.launch ?? playwrightLauncher;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const pollMs = opts.pollMs ?? 500;
  const session = await launch(opts.restore);
  try {
    await session.onApiRequest(async (req) => {
      if (isAllowedLoginRequest(req.url, req.method)) return req.allow();
      log('debug', 'browser login: blocked API call', { method: req.method, path: new URL(req.url).pathname });
      return req.deny();
    });
    await session.open(APP_URL);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cookie = (await session.cookies()).find((c) => c.name === TOKEN_COOKIE && isSalaryDomain(c.domain) && c.value);
      if (cookie) {
        // Give the app a moment to store its trusted-device data before reading it.
        await new Promise((r) => setTimeout(r, opts.settleMs ?? 1500));
        const browserState = filterStorageState(await session.storageState());
        return { accessToken: cookie.value, browserState };
      }
      if (session.isClosed()) throw new SalaryError('AUTH_REQUIRED', 'The login window was closed before login finished.');
      if (Date.now() >= deadline) {
        throw new SalaryError('AUTH_REQUIRED', `Login did not finish within ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.round(timeoutMs / 1000)} seconds`}.`, {
          hint: 'Run the login again and complete it in the browser window.',
        });
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    await session.close().catch(() => {});
  }
}

/** Real launcher: headed Chromium with a fresh, non-persistent context (no profile directory, caches or traces). */
export const playwrightLauncher: BrowserLauncher = async (restore) => {
  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (err) {
    throw new SalaryError('NOT_IMPLEMENTED', 'Browser login needs the optional playwright-core package.', {
      hint: 'Run `npm install playwright-core` and `npx playwright-core install chromium`.',
      cause: err,
    });
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: false });
  } catch (err) {
    throw new SalaryError('NOT_IMPLEMENTED', 'Could not start Chromium for browser login.', {
      hint: 'Run `npx playwright-core install chromium`. On WSL a display (WSLg) is required.',
      cause: err,
    });
  }
  const context = await browser.newContext({ ...(restore ? { storageState: restore } : {}), acceptDownloads: false, serviceWorkers: 'block' });
  let closed = false;
  browser.on('disconnected', () => (closed = true));
  context.on('close', () => (closed = true));
  const page = await context.newPage();
  page.on('close', () => (closed = true));
  return {
    async open(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },
    async onApiRequest(handler) {
      await context.route(`https://${API_HOST}/**`, (route) =>
        handler({
          url: route.request().url(),
          method: route.request().method(),
          allow: () => route.continue(),
          deny: () => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"message":"Blocked during shine-salary-mcp login"}}' }),
        }),
      );
    },
    cookies: () => context.cookies(),
    storageState: () => context.storageState() as Promise<StorageState>,
    isClosed: () => closed,
    async close() {
      await browser.close();
    },
  };
};
