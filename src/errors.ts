/**
 * Stable, safe error codes. Messages never contain credentials, tokens or
 * response bodies; `hint` tells the user what to do next.
 */
export type ErrorCode =
  // Local policy (the request never left the process)
  | 'ENDPOINT_NOT_ALLOWED'
  | 'INVALID_PARAMS'
  | 'BUDGET_EXCEEDED'
  // Authentication
  | 'AUTH_REQUIRED'
  | 'CREDENTIALS_REJECTED'
  | 'AUTH_REJECTED'
  | 'SCOPE_REQUIRED'
  | 'SCOPE_NOT_READ_ONLY'
  // Local credential store
  | 'STORE_UNAVAILABLE'
  | 'STORE_CORRUPT'
  | 'STORE_LOCKED'
  | 'LOCK_TIMEOUT'
  // Upstream
  | 'NOT_FOUND'
  | 'UPSTREAM_VALIDATION'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'REDIRECT_BLOCKED'
  | 'RESPONSE_TOO_LARGE'
  | 'BAD_RESPONSE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'CANCELLED'
  | 'NOT_IMPLEMENTED';

export class SalaryError extends Error {
  override readonly name = 'SalaryError';
  readonly code: ErrorCode;
  readonly status: number | undefined;
  readonly hint: string | undefined;
  readonly endpoint: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; hint?: string; endpoint?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.status = opts.status;
    this.hint = opts.hint;
    this.endpoint = opts.endpoint;
  }

  /** A JSON-safe view for tool results and diagnostics. */
  toSafeJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    };
  }
}

export function isSalaryError(e: unknown): e is SalaryError {
  return e instanceof SalaryError;
}
