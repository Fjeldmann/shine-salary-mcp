import { z } from 'zod';
import { Contract, Employee, Employment } from '../api/schemas.js';
import { requireCompany } from '../domain/company.js';
import { decodeCursor, pageInfo } from '../domain/cursor.js';
import { allEmployees, departmentNames, matchesQuery, projectContract, projectEmployeeBrief, resolveEmployee } from '../domain/employees.js';
import { companyId, cursor, envelope, limit, nullableString, open, responseFormat, type ToolDefinition } from './common.js';

const findInput = z.object({
  company_id: companyId,
  query: z.string().min(1).max(100).optional().describe('Name (all words must match, case-insensitive) or exact employee number (medarbejdernummer).'),
  limit: limit(),
  cursor,
});

const brief = open({ id: z.string(), name: nullableString() });

export const findEmployees: ToolDefinition<typeof findInput> = {
  name: 'salary_find_employees',
  title: 'Find employees',
  description:
    'Lists or searches employees (medarbejdere) in a company. Returns IDs, names, employee numbers, employment status, position and start date. ' +
    'Use the ID with salary_employee_summary, salary_payslip_summary or salary_time_summary. No CPR numbers, addresses or bank details are returned.',
  inputSchema: findInput,
  outputSchema: envelope({ employees: z.array(brief) }),
  async run(args, ctx) {
    const company = await requireCompany(ctx, args.company_id);
    const offset = decodeCursor(args.cursor);
    if (args.query) {
      const { items, truncated } = await allEmployees(ctx, company);
      const matches = items.filter((e) => matchesQuery(e, args.query ?? ''));
      const page = matches.slice(offset, offset + args.limit);
      ctx.sections.employees = matches.length ? 'ok' : 'empty';
      return {
        company,
        data: {
          employees: page.map((e) => projectEmployeeBrief(e)),
          pagination: pageInfo(offset, page.length, args.limit, matches.length, truncated),
          ...(truncated ? { notes: ['The company has more employees than one search reads; results may be incomplete. Narrow the query.'] } : {}),
        },
      };
    }
    const { items, total } = await ctx.list('employees.list', Employee, { query: { companyID: company.id, limit: args.limit, offset } });
    ctx.sections.employees = items.length ? 'ok' : 'empty';
    return { company, data: { employees: items.map((e) => projectEmployeeBrief(e)), pagination: pageInfo(offset, items.length, args.limit, total) } };
  },
};

const summaryInput = z
  .object({
    company_id: companyId,
    employee_id: z.guid().optional().describe('Employee ID. Preferred when known.'),
    query: z.string().min(1).max(100).optional().describe('Name or employee number, if the ID is not known. Ambiguous matches return candidates.'),
    response_format: responseFormat,
  })
  .refine((a) => a.employee_id || a.query, { message: 'Give employee_id or query.' });

export const employeeSummary: ToolDefinition<typeof summaryInput> = {
  name: 'salary_employee_summary',
  title: 'Employee summary',
  description:
    'One employee: employment (ansættelse) details, current contract (kontrakt: stilling, timer, aflønningsform) with salary rows, pension schemes (ordning and percentage) and benefits (personalegoder). ' +
    'If a name matches several people, returns candidates instead of guessing. CPR, address, contact and bank/pension account numbers are never returned.',
  inputSchema: summaryInput,
  outputSchema: envelope({
    employee: open({}).optional(),
    candidates: z.array(brief).optional(),
    employments: z.array(open({})).optional(),
    contracts: z.array(open({})).optional(),
  }),
  async run(args, ctx) {
    const company = await requireCompany(ctx, args.company_id);
    const resolved = await resolveEmployee(ctx, company, args);
    if (resolved.kind === 'many') {
      ctx.sections.employee = 'ambiguous';
      return {
        company,
        data: {
          candidates: resolved.candidates.map((e) => projectEmployeeBrief(e)),
          notes: ['Several employees match. Call again with one of the candidate IDs as employee_id.'],
        },
      };
    }
    const e = resolved.employee;
    ctx.sections.employee = 'ok';
    const departments = await departmentNames(ctx, company);
    const employments = await ctx.section('employments', () =>
      ctx.list('employments.list', Employment, { query: { employeeID: e.id } }).then((r) => r.items),
    );
    const contracts =
      args.response_format === 'detailed'
        ? await ctx.section('contracts', () => ctx.list('employeeContracts.list', Contract, { query: { employeeID: e.id } }).then((r) => r.items))
        : undefined;
    if (args.response_format !== 'detailed') ctx.sections.contracts = 'skipped';

    return {
      company,
      data: {
        employee: {
          ...projectEmployeeBrief(e, departments),
          active_contract: e.activeContract ? projectContract(e.activeContract) : null,
        },
        employments: (employments ?? []).map((m) => ({
          id: m.id,
          employee_number: m.employeeNumber ?? null,
          start_date: m.startDate ?? null,
          end_date: m.endDate ?? null,
          income_type: m.incomeType ?? null,
          preferred_tax_card_type: m.preferredTaxCardType ?? null,
        })),
        ...(contracts ? { contracts: contracts.map(projectContract) } : {}),
      },
    };
  },
};
