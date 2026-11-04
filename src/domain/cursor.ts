import { SalaryError } from '../errors.js';

/** Opaque pagination cursor: base64url of {"o": offset}. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isSafeInteger(parsed.o) && parsed.o >= 0 && parsed.o <= 1_000_000) return parsed.o;
  } catch {
    // fall through
  }
  throw new SalaryError('INVALID_PARAMS', 'The cursor is not valid. Start again without a cursor.');
}

export interface PageInfo {
  returned: number;
  total?: number;
  next_cursor?: string;
  truncated: boolean;
}

export function pageInfo(offset: number, returned: number, limit: number, total: number | undefined, truncated = false): PageInfo {
  const more = total !== undefined ? offset + returned < total : returned === limit;
  return {
    returned,
    ...(total === undefined ? {} : { total }),
    ...(more ? { next_cursor: encodeCursor(offset + returned) } : {}),
    truncated,
  };
}
