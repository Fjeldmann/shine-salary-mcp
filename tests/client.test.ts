import { describe, expect, it, vi } from 'vitest';
import { RequestBudget, SalaryClient } from '../src/api/client.js';
import { COMPANY, fakeFetch, fakeTokens, json, noSleep } from './helpers.js';

const ok = json(200, { data: [] });

function client(fetch: ReturnType<typeof fakeFetch>['fetch'], extra: Partial<ConstructorParameters<typeof SalaryClient>[0]> = {}) {
  const tokens = (extra.tokenProvider as ReturnType<typeof fakeTokens> | undefined) ?? fakeTokens('tok-1', 'tok-2', 'tok-3');
  return { c: new SalaryClient({ fetch, sleep: noSleep, random: () => 0.5, ...extra, tokenProvider: tokens }), tokens };
}

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status?: number; message: string };
  }
  throw new Error('expected rejection');
}

describe('SalaryClient transport', () => {
  it('sends a GET with the raw Authorization header and redirect: error', async () => {
    const f = fakeFetch(ok);
    const { c } = client(f.fetch);
    const res = await c.get('warnings.list', { query: { companyID: COMPANY } });
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.redirect).toBe('error');
    expect(call.headers.authorization).toBe('tok-1');
    expect(call.headers.authorization).not.toMatch(/^Bearer/i);
    expect(call.url).toBe(`https://api.salary.dk/v2/warnings?companyID=${COMPANY}`);
    expect(call.url).not.toContain('apiKey');
  });

  it('validates before touching the network or the token provider', async () => {
    const f = fakeFetch(ok);
    const tokens = fakeTokens('t');
    const { c } = client(f.fetch, { tokenProvider: tokens });
    expect((await errorOf(c.get('employees.get', { path: { employeeID: '../auth' } }))).code).toBe('INVALID_PARAMS');
    expect((await errorOf(c.get('nope' as never))).code).toBe('ENDPOINT_NOT_ALLOWED');
    expect(f.calls).toHaveLength(0);
    expect(tokens.issued).toBe(0);
  });

  it('exposes no way to choose the method', () => {
    expect(Object.getOwnPropertyNames(SalaryClient.prototype).sort()).toEqual(['constructor', 'get']);
  });

  it.each([301, 302, 307, 308])('refuses to follow a %i redirect', async (status) => {
    const f = fakeFetch(() => new Response(null, { status, headers: { location: 'https://evil.example/' } }));
    const { c } = client(f.fetch);
    expect((await errorOf(c.get('companies.list'))).code).toBe('REDIRECT_BLOCKED');
    expect(f.calls).toHaveLength(1);
  });

  it('maps a fetch-level redirect error', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });
    const { c } = client(f.fetch);
    expect((await errorOf(c.get('companies.list'))).code).toBe('REDIRECT_BLOCKED');
  });

  it('caps response size by content-length and by streamed bytes', async () => {
    const big = 'x'.repeat(2048);
    const declared = fakeFetch(() => new Response(big, { status: 200, headers: { 'content-length': '2048' } }));
    expect((await errorOf(client(declared.fetch, { maxResponseBytes: 1024 }).c.get('companies.list'))).code).toBe('RESPONSE_TOO_LARGE');

    const stream = new ReadableStream({
      start(ctl) {
        for (let i = 0; i < 4; i++) ctl.enqueue(new TextEncoder().encode(big));
        ctl.close();
      },
    });
    const streamed = fakeFetch(() => new Response(stream, { status: 200 }));
    expect((await errorOf(client(streamed.fetch, { maxResponseBytes: 4096 }).c.get('companies.list'))).code).toBe('RESPONSE_TOO_LARGE');
  });

  it('times out a hung request', async () => {
    const f = fakeFetch(
      (_call) =>
        new Promise<Response>((_resolve, reject) => {
          // Behave like fetch: reject when the signal fires.
          setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), 50);
        }),
    );
    const { c } = client(f.fetch, { timeoutMs: 10, maxRetries: 0 });
    expect((await errorOf(c.get('companies.list'))).code).toBe('TIMEOUT');
  });

  it('honours a caller abort without retrying', async () => {
    const ctl = new AbortController();
    const f = fakeFetch(() => {
      ctl.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const { c } = client(f.fetch);
    expect((await errorOf(c.get('companies.list', {}, { signal: ctl.signal }))).code).toBe('CANCELLED');
    expect(f.calls).toHaveLength(1);
  });

  it('rejects a non-JSON body', async () => {
    const f = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect((await errorOf(client(f.fetch).c.get('companies.list'))).code).toBe('BAD_RESPONSE');
  });
});

describe('SalaryClient auth handling', () => {
  it('on 401 invalidates the token, renews once and replays', async () => {
    const f = fakeFetch(json(401, {}), ok);
    const { c, tokens } = client(f.fetch);
    await c.get('companies.list');
    expect(tokens.invalidated).toEqual(['tok-1']);
    expect(f.calls.map((x) => x.headers.authorization)).toEqual(['tok-1', 'tok-2']);
  });

  it('a second 401 fails with AUTH_REJECTED after exactly two attempts', async () => {
    const f = fakeFetch(json(401, {}));
    const { c } = client(f.fetch);
    const err = await errorOf(c.get('companies.list'));
    expect(err.code).toBe('AUTH_REJECTED');
    expect(f.calls).toHaveLength(2);
  });

  it('does not retry or renew on 403', async () => {
    const f = fakeFetch(json(403, { error: { message: 'Forbidden' } }));
    const { c, tokens } = client(f.fetch);
    expect((await errorOf(c.get('companies.list'))).code).toBe('SCOPE_REQUIRED');
    expect(f.calls).toHaveLength(1);
    expect(tokens.invalidated).toEqual([]);
  });
});

describe('SalaryClient retries', () => {
  it('retries 429 honouring Retry-After seconds', async () => {
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const f = fakeFetch(json(429, {}, { 'retry-after': '3' }), ok);
    const { c } = client(f.fetch, { sleep });
    await c.get('companies.list');
    expect(sleep).toHaveBeenCalledWith(3000, undefined);
    expect(f.calls).toHaveLength(2);
  });

  it('honours Retry-After as an HTTP date', async () => {
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const now = Date.parse('2026-11-04T12:00:00Z');
    const f = fakeFetch(json(503, {}, { 'retry-after': 'Wed, 04 Nov 2026 12:00:05 GMT' }), ok);
    await client(f.fetch, { sleep, now: () => now }).c.get('companies.list');
    expect(sleep).toHaveBeenCalledWith(5000, undefined);
  });

  it('fails fast when Retry-After exceeds the cap', async () => {
    const f = fakeFetch(json(429, {}, { 'retry-after': '3600' }));
    expect((await errorOf(client(f.fetch).c.get('companies.list'))).code).toBe('RATE_LIMITED');
    expect(f.calls).toHaveLength(1);
  });

  it('retries transient 5xx with capped jittered backoff, then gives up', async () => {
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const f = fakeFetch(json(503, {}));
    const err = await errorOf(client(f.fetch, { sleep, maxRetries: 2, baseDelayMs: 100 }).c.get('companies.list'));
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(f.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((x) => x[0])).toEqual([50, 100]);
  });

  it('does not retry 500, 400, 404 or 422', async () => {
    for (const status of [500, 400, 404, 422]) {
      const f = fakeFetch(json(status, { error: { message: 'from in query is required' } }));
      await errorOf(client(f.fetch).c.get('companies.list'));
      expect(f.calls).toHaveLength(1);
    }
  });

  it('retries network failures', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    }, ok);
    await client(f.fetch).c.get('companies.list');
    expect(f.calls).toHaveLength(2);
  });

  it('stops at the request budget, counting retries', async () => {
    const f = fakeFetch(json(503, {}));
    const budget = new RequestBudget(2);
    const err = await errorOf(client(f.fetch, { maxRetries: 5 }).c.get('companies.list', {}, { budget }));
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(f.calls).toHaveLength(2);
  });
});

describe('SalaryClient errors are safe', () => {
  it('scrubs identifiers from upstream messages and never echoes the token', async () => {
    const f = fakeFetch(json(422, { error: { message: 'bad employee 010190-1234 account 1234 5678901234' } }));
    const err = await errorOf(client(f.fetch).c.get('companies.list'));
    expect(err.message).toContain('Salary said');
    expect(err.message).not.toMatch(/010190|5678901234/);
    expect(JSON.stringify(err)).not.toContain('tok-1');
  });
});

describe('SalaryClient concurrency', () => {
  it('limits concurrent requests', async () => {
    let active = 0;
    let peak = 0;
    const f = fakeFetch(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return new Response('{"data":[]}', { status: 200 });
    });
    const { c } = client(f.fetch, { maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 6 }, () => c.get('companies.list')));
    expect(peak).toBe(2);
  });
});
