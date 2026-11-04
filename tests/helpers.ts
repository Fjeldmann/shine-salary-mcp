import type { TokenProvider } from '../src/api/client.js';
import type { FetchLike } from '../src/api/http.js';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: string | undefined;
  body: string | undefined;
}

export type Responder = (call: Call, index: number) => Response | Promise<Response>;

/** A fetch double that records every call and never touches the network. */
export function fakeFetch(...responders: Responder[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: Call = {
      url: input.toString(),
      method: init.method ?? 'GET',
      headers,
      redirect: init.redirect,
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)];
    if (!responder) throw new Error('no responder');
    return responder(call, calls.length - 1);
  };
  return { fetch, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function fakeTokens(...tokens: string[]): TokenProvider & { invalidated: string[]; issued: number } {
  let i = 0;
  let current: string | undefined;
  const provider = {
    invalidated: [] as string[],
    issued: 0,
    async getToken() {
      if (current === undefined) {
        current = tokens[Math.min(i, tokens.length - 1)] ?? 'token-x';
        i += 1;
        provider.issued += 1;
      }
      return current;
    },
    invalidate(token: string) {
      provider.invalidated.push(token);
      if (token === current) current = undefined;
    },
  };
  return provider;
}

export const COMPANY = '0b6e2c1a-1111-4222-8333-444455556666';
export const EMPLOYEE = '1c7f3d2b-aaaa-4bbb-8ccc-ddddeeeeffff';
export const noSleep = async () => {};
