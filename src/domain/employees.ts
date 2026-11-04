import { z } from 'zod';
import { Contract, Department, Employee } from '../api/schemas.js';
import { SalaryError } from '../errors.js';
import { assertSameCompany, type AuthorizedCompany } from './company.js';
import type { ToolContext } from './context.js';

type EmployeeT = z.infer<typeof Employee>;
type ContractT = z.infer<typeof Contract>;

export function normalise(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('da').replace(/\s+/g, ' ').trim();
}

/** All query tokens must appear in the name; an exact employee number also matches. */
export function matchesQuery(e: EmployeeT, query: string): boolean {
  const q = normalise(query);
  if (!q) return false;
  const number = e.activeEmployment?.employeeNumber;
  if (number && normalise(number) === q) return true;
  const name = normalise(e.name ?? '');
  return q.split(' ').every((token) => name.includes(token));
}

export function projectEmployeeBrief(e: EmployeeT, departments?: Map<string, string>) {
  return {
    id: e.id,
    name: e.name ?? null,
    employee_number: e.activeEmployment?.employeeNumber ?? null,
    employment_status: e.employmentStatus ?? null,
    affiliation_type: e.affiliationType ?? null,
    position: e.activeContract?.position ?? null,
    start_date: e.activeEmployment?.startDate ?? null,
    department: e.departmentID ? (departments?.get(e.departmentID) ?? null) : null,
  };
}

export function projectContract(c: ContractT) {
  const r = c.remuneration;
  return {
    id: c.id,
    employment_id: c.employmentID ?? null,
    valid_from: c.validFrom ?? null,
    valid_to: c.validTo ?? null,
    position: c.position ?? null,
    employment_type: c.employmentType ?? null,
    remuneration_type: c.remunerationType ?? null,
    weekly_hours: c.weeklyHours ?? null,
    weekly_work_days: c.weeklyWorkDays ?? null,
    salary_amount: c.cachedSalaryAmount ?? null,
    // Pension: only title, scheme and amounts. Account, sort code and customer number are left out.
    salary: (r?.salary ?? []).map((s) => ({ title: s.title ?? null, rate: s.rate ?? null, quantity: s.quantity ?? null })),
    pension: (r?.pension ?? []).map((p) => ({ title: p.title ?? null, scheme: p.scheme ?? null, percentage: p.percentage ?? null, fixed_amount: p.fixedAmount ?? null })),
    benefits: (r?.benefits ?? []).map((b) => ({ type: b.type ?? null, title: b.title ?? null, amount: b.amount ?? null })),
  };
}

export async function departmentNames(ctx: ToolContext, company: AuthorizedCompany): Promise<Map<string, string> | undefined> {
  const list = await ctx.section('departments', () => ctx.list('departments.list', Department, { query: { companyID: company.id } }).then((r) => r.items));
  return list ? new Map(list.map((d) => [d.id, d.name ?? ''])) : undefined;
}

export async function getEmployee(ctx: ToolContext, company: AuthorizedCompany, employeeId: string): Promise<EmployeeT> {
  const e = await ctx.item('employees.get', Employee, { path: { employeeID: employeeId } });
  assertSameCompany(e.companyID, company, 'employee');
  return e;
}

export async function allEmployees(ctx: ToolContext, company: AuthorizedCompany) {
  return ctx.listAll('employees.list', Employee, { query: { companyID: company.id } });
}

export type Resolution =
  | { kind: 'one'; employee: EmployeeT }
  | { kind: 'many'; candidates: EmployeeT[]; truncated: boolean };

/** Resolve an employee by ID or by name/number. Never picks one of several matches silently. */
export async function resolveEmployee(ctx: ToolContext, company: AuthorizedCompany, ref: { employee_id?: string | undefined; query?: string | undefined }): Promise<Resolution> {
  if (ref.employee_id) return { kind: 'one', employee: await getEmployee(ctx, company, ref.employee_id) };
  if (!ref.query) throw new SalaryError('INVALID_PARAMS', 'Give either employee_id or query.');
  const { items, truncated } = await allEmployees(ctx, company);
  const matches = items.filter((e) => matchesQuery(e, ref.query ?? ''));
  if (matches.length === 1 && !truncated) return { kind: 'one', employee: await getEmployee(ctx, company, matches[0]!.id) };
  if (matches.length === 0 && !truncated) {
    throw new SalaryError('NOT_FOUND', 'No employee matches that name or employee number.', { hint: 'Try salary_find_employees with a shorter query.' });
  }
  return { kind: 'many', candidates: matches.slice(0, 20), truncated };
}
