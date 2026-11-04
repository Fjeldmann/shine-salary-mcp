import { SalaryError } from '../errors.js';

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export const USER_AGENT = 'shine-salary-mcp/0.0.0';

/** Read a response body as text, failing once `maxBytes` is exceeded. */
export async function readBodyCapped(res: Response, maxBytes: number, endpoint?: string): Promise<string> {
  const tooLarge = () =>
    new SalaryError('RESPONSE_TOO_LARGE', `Response exceeded ${maxBytes} bytes.`, {
      status: res.status,
      ...(endpoint === undefined ? {} : { endpoint }),
    });

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return '';

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Map a thrown fetch error (abort, timeout, redirect:'error', DNS...) to a safe error. */
export function mapFetchError(err: unknown, signal: AbortSignal | undefined, endpoint?: string): SalaryError {
  const ep = endpoint === undefined ? {} : { endpoint };
  if (err instanceof SalaryError) return err;
  if (signal?.aborted) return new SalaryError('CANCELLED', 'The request was cancelled.', { ...ep, cause: err });
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new SalaryError('TIMEOUT', 'The Salary API did not answer in time.', { ...ep, cause: err });
  }
  // undici reports `redirect: 'error'` as a TypeError whose cause mentions redirect.
  const text = `${String((err as Error)?.message ?? '')} ${String((err as { cause?: Error })?.cause?.message ?? '')}`;
  if (/redirect/i.test(text)) {
    return new SalaryError('REDIRECT_BLOCKED', 'The Salary API answered with a redirect, which is not followed.', {
      ...ep,
      cause: err,
    });
  }
  return new SalaryError('NETWORK_ERROR', 'Could not reach the Salary API.', { ...ep, cause: err });
}
