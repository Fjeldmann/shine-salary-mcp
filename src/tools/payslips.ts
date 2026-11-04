import { z } from 'zod';
import { PaySlip } from '../api/schemas.js';
import { requireCompany, type AuthorizedCompany } from '../domain/company.js';
import type { ToolContext } from '../domain/context.js';
import { decodeCursor, pageInfo } from '../domain/cursor.js';
import { allEmployees, getEmployee } from '../domain/employees.js';
import { CURRENCY } from '../domain/money.js';
import { SalaryError } from '../errors.js';
import { UUID_IN_TEXT, companyId, cursor, envelope, limit, open, responseFormat, type ToolDefinition } from './common.js';
import { getPayroll } from './payroll.js';

type PaySlipT = z.infer<typeof PaySlip>;

/**
 * Salary account types reported as key figures, with Danish labels. The label
 * names the Salary account so a figure is never presented as something it is not.
 */
export const KEY_FIGURES: ReadonlyArray<[account: string, label: string]> = [
  ['PayCheck', 'Udbetalt (nettoløn)'],
  ['Salary', 'Løn'],
  ['SalaryCalculated', 'Beregnet løn'],
  ['DenmarkAMIncome', 'AM-indkomst (grundlag for AM-bidrag)'],
  ['DenmarkAMTax', 'AM-bidrag'],
  ['DenmarkAIncome', 'A-indkomst'],
  ['DenmarkATax', 'A-skat'],
  ['DenmarkATPEmployee', 'ATP (medarbejderandel)'],
  ['DenmarkATPEmployer', 'ATP (arbejdsgiverandel)'],
  ['EmployeePaidPension', 'Pension (medarbejderbetalt)'],
  ['EmployerPaidPension', 'Pension (arbejdsgiverbetalt)'],
  ['Pension', 'Pension i alt'],
  ['DenmarkVacationBasis', 'Feriegrundlag (ferieberettiget løn)'],
  ['Work Hours', 'Timer'],
  ['Work Days', 'Dage'],
];
const KEY_SET = new Set(KEY_FIGURES.map(([a]) => a));

const hasId = (s: string | null | undefined) => !!s && new RegExp(UUID_IN_TEXT.source, 'i').test(s);
const stripIds = (s: string | null | undefined) => (s ? s.replace(UUID_IN_TEXT, '').replace(/\s+/g, ' ').trim() : null);

export function projectPaySlip(s: PaySlipT, employeeName: string | null, detailed: boolean) {
  const aggregates = new Map((s.aggregates ?? []).map((a) => [a.accountType ?? '', a.sum ?? null]));
  const keyFigures = KEY_FIGURES.filter(([account]) => aggregates.has(account)).map(([account, label]) => ({
    account,
    label,
    amount: aggregates.get(account) ?? null,
  }));
  return {
    id: s.id,
    employee_id: s.employeeID ?? null,
    employee_name: employeeName,
    payroll_id: s.payRollID ?? null,
    period_start: s.salaryPeriod?.start ?? null,
    period_end: s.salaryPeriod?.end ?? null,
    disposition_date: s.dispositionDate ?? null,
    settled: s.settled ?? null,
    termination: s.termination ?? null,
    currency: CURRENCY,
    pay_check: s.payCheck ?? null,
    key_figures: keyFigures,
    ...(detailed
      ? {
          // Accounts whose names embed an ID (tax cards, custom salary types) are left out.
          other_accounts: (s.aggregates ?? [])
            .filter((a) => a.accountType && !KEY_SET.has(a.accountType) && !hasId(a.accountType))
            .map((a) => ({ account: a.accountType, amount: a.sum ?? null })),
          line_items: (s.calculations ?? [])
            .filter((c) => (c.rows ?? []).length > 0)
            .map((c) => ({
              type: stripIds(c.type),
              result: c.result ?? null,
              rows: (c.rows ?? []).map((r) => ({ title: r.title ?? null, units: r.units ?? null, rate: r.rate ?? null, amount: r.amount ?? null })),
            })),
        }
      : {}),
    // `fields` (which carries CPR, address, e-mail and phone) is never read.
  };
}

const input = z
  .object({
    company_id: companyId,
    payslip_id: z.guid().optional().describe('One payslip (lønseddel).'),
    employee_id: z.guid().optional().describe("An employee's payslips, in the order Salary returns them."),
    payroll_id: z.guid().optional().describe('All payslips in one payroll run (lønkørsel).'),
    limit: limit(10, 25),
    cursor,
    response_format: responseFormat,
  })
  .refine((a) => [a.payslip_id, a.employee_id, a.payroll_id].filter(Boolean).length === 1, {
    message: 'Give exactly one of payslip_id, employee_id or payroll_id.',
  });

async function slipsFor(ctx: ToolContext, company: AuthorizedCompany, args: z.infer<typeof input>, offset: number) {
  if (args.payslip_id) {
    const slip = await ctx.item('paySlips.get', PaySlip, { path: { paySlipID: args.payslip_id } });
    // A payslip has no company field: ownership is checked through its payroll.
    if (!slip.payRollID) throw new SalaryError('NOT_FOUND', 'That payslip does not belong to the selected company.');
    await getPayroll(ctx, company, slip.payRollID);
    const e = slip.employeeID ? await getEmployee(ctx, company, slip.employeeID) : undefined;
    return { slips: [slip], names: new Map([[slip.employeeID ?? '', e?.name ?? null]]), total: 1 };
  }
  let names = new Map<string, string | null>();
  let query: Record<string, string | number>;
  if (args.employee_id) {
    const e = await getEmployee(ctx, company, args.employee_id);
    names.set(e.id, e.name ?? null);
    query = { employeeID: e.id };
  } else {
    const p = await getPayroll(ctx, company, args.payroll_id!);
    query = { payRollID: p.id };
    const all = await ctx.section('employee_names', () => allEmployees(ctx, company).then((r) => r.items));
    names = new Map((all ?? []).map((e) => [e.id, e.name ?? null]));
  }
  const page = await ctx.list('paySlips.list', PaySlip, { query: { ...query, limit: args.limit, offset } });
  // The list omits aggregates; fetch each payslip on the page for its figures.
  const slips: PaySlipT[] = [];
  for (const s of page.items) slips.push(await ctx.item('paySlips.get', PaySlip, { path: { paySlipID: s.id } }));
  return { slips, names, total: page.total, returned: page.items.length };
}

export const payslipSummary: ToolDefinition<typeof input> = {
  name: 'salary_payslip_summary',
  title: 'Payslip summary',
  description:
    'Payslips (lønsedler) for one employee, one payroll run, or one payslip ID. Each has period, dispositionsdato, udbetalt beløb (nettoløn) and labelled key figures ' +
    'from Salary: løn, A-indkomst, A-skat, AM-indkomst, AM-bidrag, ATP, pension, feriegrundlag, timer — all in DKK, using Salary\'s own account names. ' +
    'Detailed mode adds every calculation line (linjer). CPR numbers and contact details on the payslip are never returned.',
  inputSchema: input,
  outputSchema: envelope({ payslips: z.array(open({ id: z.string() })) }),
  maxRequests: 40,
  async run(args, ctx) {
    const company = await requireCompany(ctx, args.company_id);
    const offset = decodeCursor(args.cursor);
    const r = await slipsFor(ctx, company, args, offset);
    ctx.sections.payslips = r.slips.length ? 'ok' : 'empty';
    const detailed = args.response_format === 'detailed';
    return {
      company,
      data: {
        payslips: r.slips.map((s) => projectPaySlip(s, r.names.get(s.employeeID ?? '') ?? null, detailed)),
        ...(args.payslip_id ? {} : { pagination: pageInfo(offset, r.returned ?? r.slips.length, args.limit, r.total) }),
      },
    };
  },
};
