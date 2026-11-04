import { z } from 'zod';
import type { SalaryClient } from '../api/client.js';
import { ToolContext } from '../domain/context.js';
import type { AuthorizedCompany } from '../domain/company.js';
import { isSalaryError, SalaryError } from '../errors.js';
import { log } from '../log.js';
import { maskPersonalData, scrubFreeText } from '../privacy/redact.js';

export const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const companyId = z.guid().describe('Salary company ID (from salary_company_overview).');
export const responseFormat = z
  .enum(['concise', 'detailed'])
  .default('concise')
  .describe('"concise" (default) returns the key facts; "detailed" adds line items and rows.');
export const limit = (def = 25, max = 100) => z.number().int().min(1).max(max).default(def).describe(`Page size (default ${def}, max ${max}).`);
export const cursor = z.string().max(200).optional().describe('Opaque cursor from a previous result\'s pagination.next_cursor.');
export const isoDate = z.iso.date().describe('Date, YYYY-MM-DD.');

/**
 * Output objects are open: Salary adds fields over time, and results carry
 * optional sections. Declared explicitly as `additionalProperties: true`
 * (zod's default `{}` constrains nothing and trips schema-portability checks).
 */
export function open<S extends z.ZodRawShape>(shape: S) {
  return z.looseObject(shape).meta({ additionalProperties: true });
}

/** Nullable string as `anyOf` with single types (more portable than `type: [..., "null"]`). */
export const nullableString = () => z.union([z.string(), z.literal(null)]);

const pagination = open({ returned: z.number(), total: z.number().optional(), next_cursor: z.string().optional(), truncated: z.boolean() });

/** Fields every tool result carries. */
export function envelope<S extends z.ZodRawShape>(shape: S) {
  return open({
    retrieved_at: z.string(),
    company: open({ id: z.string(), name: z.string() }).nullable(),
    sections: z.record(z.string(), z.string()),
    sources: z.array(z.string()),
    pagination: pagination.optional(),
    notes: z.array(z.string()).optional(),
    ...shape,
  });
}

export interface ToolDefinition<I extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: z.ZodType;
  /** Upper bound on HTTP requests for one call. */
  maxRequests?: number;
  run(args: z.infer<I>, ctx: ToolContext): Promise<{ company: AuthorizedCompany | null; data: Record<string, unknown> }>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Run a tool: build the envelope, mask personal data as the last step, map errors to safe results. */
export async function runTool<I extends z.ZodObject>(
  def: ToolDefinition<I>,
  args: z.infer<I>,
  client: SalaryClient,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const ctx = new ToolContext(client, signal, def.maxRequests ?? 40);
  try {
    const { company, data } = await def.run(args, ctx);
    const result = maskPersonalData({
      retrieved_at: ctx.now().toISOString(),
      company,
      sections: ctx.sections,
      sources: [...ctx.sources].sort(),
      ...data,
    }) as Record<string, unknown>;
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (err) {
    const safe = isSalaryError(err)
      ? err
      : new SalaryError('UPSTREAM_ERROR', 'The tool failed unexpectedly.', { hint: 'Check the server log (stderr).' });
    if (!isSalaryError(err)) log('error', `tool ${def.name} failed`, { name: (err as Error)?.name ?? 'unknown', message: String((err as Error)?.message ?? '') });
    else log('info', `tool ${def.name} error`, { code: err.code });
    const body = maskPersonalData({ error: safe.toSafeJSON(), sources: [...ctx.sources].sort() });
    return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
  }
}

/** Untrusted free text from Salary (notes, parameters): bounded, never interpreted. */
export function untrustedText(value: unknown, max = 200): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const clean = scrubFreeText(text.replace(/[\u0000-\u001f\u007f]/g, ' ')).trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function currentYearRange(now: Date): { from: string; to: string } {
  const y = now.getUTCFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

export function checkRange(from: string, to: string, maxDays: number): void {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 0) throw new SalaryError('INVALID_PARAMS', '"from" must be on or before "to".');
  if (days > maxDays) throw new SalaryError('INVALID_PARAMS', `The date range may span at most ${maxDays} days.`);
}
