/**
 * Privacy guards that apply to every value leaving the process.
 *
 * Field names come from the Salary swagger definitions (employee, company,
 * paymentConfiguration, incomeTaxReport; checked 2026-11-04). Tools should
 * still project responses to approved fields first; this is the safety net
 * behind the projection, not a replacement for it.
 */

export const MASK = '[masked]';

/** Identifiers that are masked wherever they appear. Keys are compared case-insensitively. */
const MASKED_KEYS = new Set(
  ['nationalID', 'cpr', 'tin', 'bankAccountNumber', 'bankRegistrationNumber', 'iban', 'swift', 'bic'].map((k) =>
    k.toLowerCase(),
  ),
);

/** Personal or secret fields that are removed entirely. */
const DROPPED_KEYS = new Set(
  [
    'address',
    'city',
    'postalCode',
    'birthDate',
    'phoneNumber',
    'phoneNumberCountryCode',
    'email',
    'emergencyContact',
    'employeeEmergencyContact',
    'calendarFeedKey',
    'profileImageURL',
    'accessToken',
    'apiClientToken',
    'csrfToken',
    'apiClientSecret',
    'apiKey',
    'key',
    'secret',
    'password',
  ].map((k) => k.toLowerCase()),
);

/** Danish CPR: DDMMYY-NNNN or DDMMYYNNNN, with plausible day/month. */
const CPR_RE = /(?<![\d-])(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])\d{2}[- ]?\d{4}(?![\d-])/g;
/** Danish bank account: 4-digit reg. no. followed by a 6-10 digit account no. */
const BANK_RE = /(?<![\d-])\d{4}[- ]\d{6,10}(?![\d-])/g;
/** IBAN (any country). */
const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g;

/** Mask CPR, bank and IBAN patterns embedded in free text (notes, error messages). */
export function scrubText(text: string): string {
  return text.replace(IBAN_RE, MASK).replace(CPR_RE, MASK).replace(BANK_RE, MASK);
}

/**
 * Deep-copy `value`, masking identifier fields, dropping personal/secret
 * fields and scrubbing identifiers out of every string.
 */
export function maskPersonalData(value: unknown, depth = 0): unknown {
  if (depth > 64) return MASK;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => maskPersonalData(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      if (DROPPED_KEYS.has(lower)) continue;
      if (MASKED_KEYS.has(lower)) {
        out[k] = v === null || v === undefined || v === '' ? v : MASK;
        continue;
      }
      out[k] = maskPersonalData(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Remove credentials from a diagnostic line: known secret values, header
 * values and long token-like strings.
 */
export function redactSecrets(text: string, knownSecrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return scrubText(
    out
      .replace(/\b(authorization|cookie|set-cookie|x-csrf-token)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted]')
      .replace(/\b(api[-_]?key|apiClientSecret|api[-_]?client[-_]?secret|accessToken|token|password)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2[redacted]')
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]'),
  );
}
