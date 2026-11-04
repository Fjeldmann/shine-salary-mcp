import type { z } from 'zod';
import type { EndpointId } from '../api/allowlist.js';
import { RequestBudget, type SalaryClient } from '../api/client.js';
import type { RequestParams } from '../api/request.js';
import { listEnvelope, itemEnvelope, Pagination, parseResponse } from '../api/schemas.js';
import { isSalaryError } from '../errors.js';

export type SectionStatus = 'ok' | 'empty' | 'ambiguous' | 'permission_denied' | 'not_found' | 'error' | 'skipped';

/** Per tool call: the client, a request budget, the caller's cancellation signal and provenance. */
export class ToolContext {
  readonly budget: RequestBudget;
  readonly sources = new Set<string>();
  readonly sections: Record<string, SectionStatus> = {};

  constructor(
    readonly client: SalaryClient,
    readonly signal: AbortSignal | undefined,
    maxRequests = 40,
    readonly now: () => Date = () => new Date(),
  ) {
    this.budget = new RequestBudget(maxRequests);
  }

  async #get(id: EndpointId, params: RequestParams): Promise<unknown> {
    this.sources.add(id);
    const res = await this.client.get(id, params, { budget: this.budget, ...(this.signal ? { signal: this.signal } : {}) });
    return res.body;
  }

  async item<T extends z.ZodType>(id: EndpointId, schema: T, params: RequestParams = {}): Promise<z.infer<T>> {
    return (parseResponse(itemEnvelope(schema), await this.#get(id, params), id) as { data: z.infer<T> }).data;
  }

  async list<T extends z.ZodType>(id: EndpointId, schema: T, params: RequestParams = {}): Promise<{ items: z.infer<T>[]; total: number | undefined }> {
    const parsed = parseResponse(listEnvelope(schema), await this.#get(id, params), id) as {
      data: z.infer<T>[];
      pagination?: z.infer<typeof Pagination>;
    };
    return { items: parsed.data, total: parsed.pagination?.count ?? undefined };
  }

  /**
   * Fetch all pages of a list, `pageSize` at a time, until done or `maxItems`.
   * Reports `truncated` when it stopped early (item cap or request budget).
   */
  async listAll<T extends z.ZodType>(
    id: EndpointId,
    schema: T,
    params: RequestParams,
    { pageSize = 500, maxItems = 5000 } = {},
  ): Promise<{ items: z.infer<T>[]; truncated: boolean }> {
    const items: z.infer<T>[] = [];
    for (let offset = 0; ; offset += pageSize) {
      if (this.budget.remaining <= 1) return { items, truncated: true };
      const page = await this.list(id, schema, { ...params, query: { ...params.query, limit: pageSize, offset } });
      items.push(...page.items);
      const done = page.items.length < pageSize || (page.total !== undefined && offset + page.items.length >= page.total);
      if (done) return { items, truncated: false };
      if (items.length >= maxItems) return { items, truncated: true };
    }
  }

  /**
   * Run an optional section. Permission and not-found failures are recorded
   * per section instead of failing the whole tool; anything else propagates.
   */
  async section<T>(name: string, fn: () => Promise<T>, isEmpty: (v: T) => boolean = (v) => Array.isArray(v) && v.length === 0): Promise<T | undefined> {
    try {
      const v = await fn();
      this.sections[name] = isEmpty(v) ? 'empty' : 'ok';
      return v;
    } catch (err) {
      if (isSalaryError(err) && err.code === 'SCOPE_REQUIRED') this.sections[name] = 'permission_denied';
      else if (isSalaryError(err) && err.code === 'NOT_FOUND') this.sections[name] = 'not_found';
      else throw err;
      return undefined;
    }
  }
}
