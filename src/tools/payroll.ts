import { z } from 'zod';
import { PayRoll, PayRollDeviation, Transfer } from '../api/schemas.js';
import { assertSameCompany, requireCompany, type AuthorizedCompany } from '../domain/company.js';
import type { ToolContext } from '../domain/context.js';
import { decodeCursor, pageInfo } from '../domain/cursor.js';
import { CURRENCY, sumAmounts } from '../domain/money.js';
import { checkRange, companyId, currentYearRange, cursor, envelope, isoDate, limit, open, responseFormat, type ToolDefinition } from './common.js';

type PayRollT = z.infer<typeof PayRoll>;

export function projectPayroll(p: PayRollT) {
  return {
    id: p.id,
    type: p.payRollType ?? null,
    status: p.status ?? null,
    period_start: p.salaryPeriod?.start ?? null,
    period_end: p.salaryPeriod?.end ?? null,
    disposition_date: p.dispositionDate ?? null,
    frequency: p.salaryCycle?.frequency ?? null,
    approved: p.isApproved ?? null,
    rejected: p.isRejected ?? null,
    tentative: p.isTentative ?? null,
    totals: {
      currency: CURRENCY,
      paycheck: p.totalPaycheck ?? null,
      transfer: p.totalTransfer ?? null,
      invoice: p.totalInvoice ?? null,
      hours: p.totalHours ?? null,
    },
  };
}

export async function getPayroll(ctx: ToolContext, company: AuthorizedCompany, payrollId: string): Promise<PayRollT> {
  const p = await ctx.item('payRolls.get', PayRoll, { path: { payRollID: payrollId } });
  assertSameCompany(p.companyID, company, 'payroll');
  return p;
}

const input = z.object({
  company_id: companyId,
  payroll_id: z.guid().optional().describe('One payroll run (lønkørsel). Adds deviations and transfers.'),
  from: isoDate.optional().describe('Start of the disposition-date range. Default: 1 January this year.'),
  to: isoDate.optional().describe('End of the range. Default: 31 December this year. Max span 3 years.'),
  limit: limit(),
  cursor,
  response_format: responseFormat,
});

export const payrollOverview: ToolDefinition<typeof input> = {
  name: 'salary_payroll_overview',
  title: 'Payroll overview',
  description:
    'Payroll runs (lønkørsler) in a date range: period, dispositionsdato, type (Ordinary, Negation…), status, approval, and totals ' +
    '(udbetalt løn = totalPaycheck, overførsler, faktura, timer) in DKK. With payroll_id: that run plus deviations from the previous run ' +
    '(afvigelser: timer, skattekort, bruttoløn, udbetaling) and transfers (overførsler) by type and state. Detailed mode lists every deviation and transfer.',
  inputSchema: input,
  outputSchema: envelope({
    payrolls: z.array(open({ id: z.string() })).optional(),
    payroll: open({ id: z.string() }).optional(),
    deviations: open({}).nullable().optional(),
    transfers: open({}).nullable().optional(),
  }),
  async run(args, ctx) {
    const company = await requireCompany(ctx, args.company_id);

    if (args.payroll_id) {
      const p = await getPayroll(ctx, company, args.payroll_id);
      ctx.sections.payroll = 'ok';
      const detailed = args.response_format === 'detailed';
      const deviations = await ctx.section('deviations', () =>
        ctx.list('payRollDeviations.list', PayRollDeviation, { query: { payRollID: p.id } }).then((r) => r.items),
      );
      const transfers = await ctx.section('transfers', () =>
        ctx.listAll('transfers.list', Transfer, { query: { payRollID: p.id } }, { pageSize: 500, maxItems: 2000 }),
        (v) => v.items.length === 0,
      );
      const countBy = <T>(items: T[], key: (t: T) => string) =>
        items.reduce<Record<string, number>>((acc, t) => ((acc[key(t)] = (acc[key(t)] ?? 0) + 1), acc), {});
      return {
        company,
        data: {
          payroll: projectPayroll(p),
          deviations: deviations
            ? {
                count: deviations.length,
                by_type: countBy(deviations, (d) => d.type ?? 'Unknown'),
                ...(detailed
                  ? { items: deviations.map((d) => ({ employee_id: d.employeeID ?? null, type: d.type ?? null, value_before: d.valueBefore ?? null, value_after: d.valueAfter ?? null })) }
                  : {}),
              }
            : null,
          transfers: transfers
            ? {
                count: transfers.items.length,
                complete: !transfers.truncated,
                currency: CURRENCY,
                total_amount: sumAmounts(transfers.items.map((t) => t.amount)),
                by_type: countBy(transfers.items, (t) => t.type ?? 'Unknown'),
                by_state: countBy(transfers.items, (t) => t.state ?? 'Unknown'),
                // The free-text recipient is left out on purpose.
                ...(detailed
                  ? {
                      items: transfers.items.map((t) => ({
                        type: t.type ?? null,
                        amount: t.amount ?? null,
                        payment_date: t.paymentDate ?? null,
                        state: t.state ?? null,
                        payment_method: t.paymentMethod ?? null,
                        employee_id: t.employeeID ?? null,
                      })),
                    }
                  : {}),
              }
            : null,
        },
      };
    }

    const range = { ...currentYearRange(ctx.now()), ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) };
    checkRange(range.from, range.to, 1100);
    const offset = decodeCursor(args.cursor);
    const { items, total } = await ctx.list('payRolls.list', PayRoll, {
      query: { companyID: company.id, from: range.from, to: range.to, limit: args.limit, offset },
    });
    items.forEach((p) => assertSameCompany(p.companyID ?? company.id, company, 'payroll'));
    ctx.sections.payrolls = items.length ? 'ok' : 'empty';
    return {
      company,
      data: {
        range,
        payrolls: items.map(projectPayroll),
        pagination: pageInfo(offset, items.length, args.limit, total),
      },
    };
  },
};
