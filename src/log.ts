import { redactSecrets } from './privacy/redact.js';

/**
 * Diagnostics go to stderr only: in `serve`, stdout carries JSON-RPC and
 * nothing else. Every line passes through the secret redactor.
 */
const secrets = new Set<string>();

/** Register a credential value so it is redacted if it ever reaches a log line. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

/** Redact a free-form message (e.g. an unexpected error) with the registered secrets. */
export function redact(text: string): string {
  return redactSecrets(text, secrets);
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = process.env.SHINE_SALARY_LOG_LEVEL as LogLevel | undefined;
  return ORDER[env ?? 'info'] ?? ORDER.info;
}

export function log(level: LogLevel, message: string, fields: Record<string, string | number | boolean> = {}): void {
  if (ORDER[level] < threshold()) return;
  const extra = Object.entries(fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  const line = `${new Date().toISOString()} ${level} ${message}${extra ? ` ${extra}` : ''}`;
  process.stderr.write(`${redactSecrets(line, secrets)}\n`);
}
