import { z } from 'zod';
import { LeaveType, TimeRegistration } from '../api/schemas.js';
import { requireCompany } from '../domain/company.js';
import { decodeCursor, pageInfo } from '../domain/cursor.js';
import { allEmployees, getEmployee } from '../domain/employees.js';
import { sumHours } from '../domain/money.js';
import { checkRange, companyId, cursor, envelope, isoDate, limit, responseFormat, untrustedText, type ToolDefinition } from './common.js';

const input = z.object({
  company_id: companyId,
  from: isoDate,
  to: isoDate.describe('End date, YYYY-MM-DD. Max span 366 days.'),
  employee_id: z.guid().optional().describe('Only this employee.'),
  state: z.enum(['Pending', 'Settled', 'Cancelled']).optional().describe('Pending = not yet in a payroll; Settled = paid out in a payroll.'),
  limit: limit(50, 100).describe('Rows per page in detailed mode (default 50, max 100). Totals always cover every row read.'),
  cursor,
  response_format: responseFormat,
});

export const timeSummary: ToolDefinition<typeof input> = {
  name: 'salary_time_summary',
  title: 'Time and leave registrations',
  description:
    'Time registrations (tidsregistreringer) and leave (fravær: ferie, sygdom, afspadsering…) in a date range, totalled per employee and kind ' +
    '(timer, dage, minutter), with leave-type names. Detailed mode lists the rows. ' +
    'This shows what was registered; it is NOT a remaining leave balance (feriesaldo).',
  inputSchema: input,
  outputSchema: envelope({ totals: z.array(z.looseObject({})), registrations: z.array(z.looseObject({})).optional() }),
  maxRequests: 30,
  async run(args, ctx) {
    const company = await requireCompany(ctx, args.company_id);
    checkRange(args.from, args.to, 366);
    const offset = decodeCursor(args.cursor);

    let names: Map<string, string | null>;
    if (args.employee_id) {
      const e = await getEmployee(ctx, company, args.employee_id);
      names = new Map([[e.id, e.name ?? null]]);
    } else {
      const all = await ctx.section('employee_names', () => allEmployees(ctx, company).then((r) => r.items));
      names = new Map((all ?? []).map((e) => [e.id, e.name ?? null]));
    }
    const leaveTypes = await ctx.section('leave_types', () => ctx.listAll('leaveTypes.list', LeaveType, { query: { companyID: company.id } }).then((r) => r.items));
    const leaveNames = new Map((leaveTypes ?? []).map((l) => [l.id, l.name ?? null]));

    const scope = args.employee_id ? { employeeID: args.employee_id } : { companyID: company.id };
    const { items, truncated } = await ctx.listAll(
      'timeRegistrations.list',
      TimeRegistration,
      { query: { ...scope, from: args.from, to: args.to, ...(args.state ? { stateFilter: args.state } : {}) } },
      { pageSize: 500, maxItems: 10_000 },
    );
    // Rows must belong to known employees of this company (defence in depth when listing by company).
    const rows = args.employee_id ? items.filter((t) => t.employeeID === args.employee_id) : items;
    ctx.sections.registrations = rows.length ? 'ok' : 'empty';

    const groups = new Map<string, { employee_id: string | null; employee_name: string | null; class: string | null; leave_type: string | null; count: number; hours: number[]; days: number[]; minutes: number[] }>();
    for (const t of rows) {
      const leave = t.leaveTypeID ? (leaveNames.get(t.leaveTypeID) ?? 'Unknown leave type') : null;
      const key = `${t.employeeID}|${t.class}|${leave}`;
      let g = groups.get(key);
      if (!g) {
        g = { employee_id: t.employeeID ?? null, employee_name: names.get(t.employeeID ?? '') ?? null, class: t.class ?? null, leave_type: leave, count: 0, hours: [], days: [], minutes: [] };
        groups.set(key, g);
      }
      g.count += 1;
      g.hours.push(t.hours ?? 0);
      g.days.push(t.days ?? 0);
      g.minutes.push(t.minutes ?? 0);
    }
    const totals = [...groups.values()]
      .map((g) => ({ employee_id: g.employee_id, employee_name: g.employee_name, class: g.class, leave_type: g.leave_type, registrations: g.count, hours: sumHours(g.hours), days: sumHours(g.days), minutes: sumHours(g.minutes) }))
      .sort((a, b) => `${a.employee_name}${a.class}${a.leave_type}`.localeCompare(`${b.employee_name}${b.class}${b.leave_type}`, 'da'));

    const detailed = args.response_format === 'detailed';
    const page = detailed ? rows.slice(offset, offset + args.limit) : [];
    return {
      company,
      data: {
        range: { from: args.from, to: args.to },
        totals,
        totals_complete: !truncated,
        ...(detailed
          ? {
              registrations: page.map((t) => ({
                id: t.id,
                employee_id: t.employeeID ?? null,
                employee_name: names.get(t.employeeID ?? '') ?? null,
                date: t.date ?? null,
                class: t.class ?? null,
                leave_type: t.leaveTypeID ? (leaveNames.get(t.leaveTypeID) ?? null) : null,
                hours: t.hours ?? null,
                days: t.days ?? null,
                minutes: t.minutes ?? null,
                state: t.state ?? null,
                approved: t.approved ?? null,
                note: untrustedText(t.note) ?? null,
              })),
              pagination: pageInfo(offset, page.length, args.limit, rows.length, truncated),
            }
          : {}),
        notes: [
          'Registrations only; not a remaining leave balance.',
          ...(truncated ? ['Stopped before reading every registration; totals are incomplete. Use a shorter range.'] : []),
        ],
      },
    };
  },
};
