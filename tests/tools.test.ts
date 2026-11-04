import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { runTool, type ToolDefinition } from '../src/tools/common.js';
import { TOOLS } from '../src/tools/index.js';
import { A, B, E1, E2, EB, FORBIDDEN, P1, PB, S1, SB, fakeSalary, type FakeOptions } from './fake-salary.js';

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t])) as Record<string, ToolDefinition>;

async function call(name: string, args: Record<string, unknown>, opts: FakeOptions = {}) {
  const tool = byName[name]!;
  const { client, calls } = fakeSalary(opts);
  const result = await runTool(tool, tool.inputSchema.parse(args), client);
  const text = result.content[0]!.text;
  for (const s of FORBIDDEN) expect(text, `output of ${name} contains ${s}`).not.toContain(s);
  if (result.structuredContent) expect(JSON.stringify(result.structuredContent)).toBe(text);
  return { result, s: (result.structuredContent ?? JSON.parse(text)) as Record<string, any>, calls };
}

describe('tool registry', () => {
  it('has six read-only tools in a fixed order', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'salary_company_overview',
      'salary_find_employees',
      'salary_employee_summary',
      'salary_payroll_overview',
      'salary_payslip_summary',
      'salary_time_summary',
    ]);
  });
});

describe('salary_company_overview', () => {
  it('lists companies without an ID', async () => {
    const { s } = await call('salary_company_overview', {});
    expect(s.companies).toEqual([{ id: A, name: 'Test ApS' }]);
  });

  it('summarises a company without CVR, bank or address, and treats warning text as data', async () => {
    const { s } = await call('salary_company_overview', { company_id: A, response_format: 'detailed' });
    expect(s.company_details).toEqual({ id: A, name: 'Test ApS', state: 'Active', employee_count: 3 });
    expect(s.warnings.by_severity).toEqual({ EmployeeBlocking: 1 });
    expect(s.warnings.items[0].parameter).toContain('Ignore previous instructions');
    expect(s.sections).toMatchObject({ company: 'ok', active_payrolls: 'ok', warnings: 'ok' });
  });

  it('refuses a company the credentials cannot see', async () => {
    const { result, s } = await call('salary_company_overview', { company_id: B });
    expect(result.isError).toBe(true);
    expect(s.error.code).toBe('NOT_FOUND');
  });

  it('reports a denied section without failing the tool', async () => {
    const { result, s } = await call('salary_company_overview', { company_id: A }, { deny: ['/v2/warnings'] });
    expect(result.isError).toBeUndefined();
    expect(s.sections.warnings).toBe('permission_denied');
    expect(s.sections.active_payrolls).toBe('ok');
  });
});

describe('employees', () => {
  it('lists and searches, case-insensitively and with Danish letters', async () => {
    expect((await call('salary_find_employees', { company_id: A })).s.employees).toHaveLength(3);
    expect((await call('salary_find_employees', { company_id: A, query: 'anne' })).s.employees.map((e: any) => e.id)).toEqual([E1, E2]);
    expect((await call('salary_find_employees', { company_id: A, query: 'ØRSTED' })).s.employees[0].name).toBe('Bo Ørsted');
    expect((await call('salary_find_employees', { company_id: A, query: '2' })).s.employees[0].id).toBe(E2);
  });

  it('paginates with an opaque cursor', async () => {
    const first = (await call('salary_find_employees', { company_id: A, limit: 2 })).s;
    expect(first.employees).toHaveLength(2);
    const next = (await call('salary_find_employees', { company_id: A, limit: 2, cursor: first.pagination.next_cursor })).s;
    expect(next.employees).toHaveLength(1);
    expect(next.pagination.next_cursor).toBeUndefined();
    expect((await call('salary_find_employees', { company_id: A, cursor: 'garbage' })).s.error.code).toBe('INVALID_PARAMS');
  });

  it('returns candidates for an ambiguous name instead of picking one', async () => {
    const { s } = await call('salary_employee_summary', { company_id: A, query: 'Anne' });
    expect(s.candidates.map((c: any) => c.id)).toEqual([E1, E2]);
    expect(s.employee).toBeUndefined();
    expect(s.sections.employee).toBe('ambiguous');
  });

  it('summarises one employee with contract and pension, but no account numbers', async () => {
    const { s } = await call('salary_employee_summary', { company_id: A, employee_id: E1, response_format: 'detailed' });
    expect(s.employee).toMatchObject({ id: E1, name: 'Anne Hansen', employee_number: '1', department: 'Udvikling' });
    expect(s.employee.active_contract.pension).toEqual([{ title: 'Pension', scheme: 'EmployeePaid', percentage: 4, fixed_amount: null }]);
    expect(s.employee.active_contract.benefits).toEqual([{ type: 'Telephone', title: 'Telefon', amount: 275 }]);
    expect(s.contracts).toHaveLength(1);
  });

  it('refuses an employee from another company', async () => {
    const { s } = await call('salary_employee_summary', { company_id: A, employee_id: EB });
    expect(s.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(s)).not.toContain('Fremmed');
  });
});

describe('salary_payroll_overview', () => {
  it('lists payrolls for the current year by default', async () => {
    const { s, calls } = await call('salary_payroll_overview', { company_id: A });
    const y = new Date().getUTCFullYear();
    expect(calls.some((c) => c.includes(`from=${y}-01-01`) && c.includes(`to=${y}-12-31`))).toBe(true);
    expect(s.payrolls[0]).toMatchObject({ id: P1, status: 'Success', totals: { currency: 'DKK', paycheck: 70000.1 } });
  });

  it('adds deviations and exact transfer totals, without recipients', async () => {
    const { s } = await call('salary_payroll_overview', { company_id: A, payroll_id: P1, response_format: 'detailed' });
    expect(s.deviations.by_type).toEqual({ 'Gross Pay': 1 });
    expect(s.transfers.total_amount).toBe(30000.3); // integer-øre sum, not 30000.300000000003
    expect(s.transfers.complete).toBe(true);
  });

  it('refuses another company\'s payroll and bad ranges', async () => {
    expect((await call('salary_payroll_overview', { company_id: A, payroll_id: PB })).s.error.code).toBe('NOT_FOUND');
    expect((await call('salary_payroll_overview', { company_id: A, from: '2026-02-01', to: '2026-01-01' })).s.error.code).toBe('INVALID_PARAMS');
    expect((await call('salary_payroll_overview', { company_id: A, from: '2020-01-01', to: '2026-01-01' })).s.error.code).toBe('INVALID_PARAMS');
  });
});

describe('salary_payslip_summary', () => {
  it('labels key figures and drops fields and ID-bearing accounts', async () => {
    const { s } = await call('salary_payslip_summary', { company_id: A, payroll_id: P1, response_format: 'detailed' });
    const slip = s.payslips[0];
    expect(slip).toMatchObject({ id: S1, employee_name: 'Anne Hansen', pay_check: 30000.25, currency: 'DKK' });
    expect(slip.key_figures.map((k: any) => k.account)).toEqual(['PayCheck', 'DenmarkAIncome', 'DenmarkATax', 'DenmarkAMTax'].sort((a, b) => ['PayCheck', 'DenmarkAMTax', 'DenmarkAIncome', 'DenmarkATax'].indexOf(a) - ['PayCheck', 'DenmarkAMTax', 'DenmarkAIncome', 'DenmarkATax'].indexOf(b)));
    expect(slip.key_figures.find((k: any) => k.account === 'DenmarkATax').label).toBe('A-skat');
    expect(JSON.stringify(slip.other_accounts ?? [])).not.toContain('Taxcard');
    expect(slip.line_items[0].rows[0].title).toBe('Løn for [masked]');
  });

  it('works by employee and by payslip ID, checking ownership through the payroll', async () => {
    expect((await call('salary_payslip_summary', { company_id: A, employee_id: E1 })).s.payslips).toHaveLength(1);
    expect((await call('salary_payslip_summary', { company_id: A, payslip_id: S1 })).s.payslips[0].id).toBe(S1);
    expect((await call('salary_payslip_summary', { company_id: A, payslip_id: SB })).s.error.code).toBe('NOT_FOUND');
  });

  it('requires exactly one selector', () => {
    const tool = byName.salary_payslip_summary!;
    expect(() => tool.inputSchema.parse({ company_id: A })).toThrow();
    expect(() => tool.inputSchema.parse({ company_id: A, employee_id: E1, payroll_id: P1 })).toThrow();
  });
});

describe('salary_time_summary', () => {
  it('totals per employee and kind, with leave names, and scrubs notes', async () => {
    const { s } = await call('salary_time_summary', { company_id: A, from: '2026-10-01', to: '2026-10-31', response_format: 'detailed' });
    expect(s.totals).toEqual([
      expect.objectContaining({ employee_id: E1, class: 'Hours', registrations: 2, hours: 14.8 }),
      expect.objectContaining({ employee_id: E2, class: 'Leave', leave_type: 'DenmarkVacationPaid', days: 1 }),
    ]);
    expect(s.totals_complete).toBe(true);
    expect(s.registrations[0].note).toContain('[masked]');
    expect(s.notes[0]).toMatch(/not a remaining leave balance/);
  });

  it('distinguishes empty from denied', async () => {
    expect((await call('salary_time_summary', { company_id: A, from: '2026-10-01', to: '2026-10-31' }, { timeRegistrations: [] })).s.sections.registrations).toBe('empty');
    const denied = await call('salary_time_summary', { company_id: A, from: '2026-10-01', to: '2026-10-31' }, { deny: ['/v2/timeRegistrations'] });
    expect(denied.s.error.code).toBe('SCOPE_REQUIRED');
  });

  it('passes unknown enum values through', async () => {
    const { s } = await call('salary_time_summary', { company_id: A, from: '2026-10-01', to: '2026-10-31' }, { timeRegistrations: [{ id: 'x', employeeID: E1, class: 'Teleport', hours: 1 }] });
    expect(s.totals[0].class).toBe('Teleport');
  });
});

describe('MCP round trip (in-memory transport)', () => {
  async function connect() {
    const { client } = fakeSalary();
    const server = createServer({ client });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const pending = new Map<number, (m: any) => void>();
    clientSide.onmessage = (m: any) => pending.get(m.id)?.(m);
    await clientSide.start();
    let id = 0;
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const request = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve) => {
        id += 1;
        pending.set(id, resolve);
        void clientSide.send({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } } as never);
      });
    return { request };
  }

  it('lists six annotated tools and validates structured output against the output schema', async () => {
    const { request } = await connect();
    const list = await request('tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toHaveLength(6);
    for (const t of list.result.tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      expect(t.outputSchema).toBeTruthy();
    }
    for (const [name, args] of [
      ['salary_company_overview', { company_id: A, response_format: 'detailed' }],
      ['salary_find_employees', { company_id: A, query: 'anne' }],
      ['salary_employee_summary', { company_id: A, employee_id: E1, response_format: 'detailed' }],
      ['salary_payroll_overview', { company_id: A, payroll_id: P1, response_format: 'detailed' }],
      ['salary_payslip_summary', { company_id: A, payroll_id: P1, response_format: 'detailed' }],
      ['salary_time_summary', { company_id: A, from: '2026-10-01', to: '2026-10-31', response_format: 'detailed' }],
    ] as const) {
      const res = await request('tools/call', { name, arguments: args });
      expect(res.error, `${name}: ${JSON.stringify(res.error)}`).toBeUndefined();
      expect(res.result.isError, `${name}: ${JSON.stringify(res.result.content)}`).toBeFalsy();
      expect(res.result.structuredContent.company).toEqual({ id: A, name: 'Test ApS' });
    }
  });

  it('rejects invalid input before calling Salary', async () => {
    const { request } = await connect();
    const res = await request('tools/call', { name: 'salary_payroll_overview', arguments: { company_id: 'not-a-uuid' } });
    expect(res.error ?? res.result.isError).toBeTruthy();
  });
});
