import { z } from 'zod';
import { ActivePayroll, CompanyDetail, Warning } from '../api/schemas.js';
import { authorizedCompanies, requireCompany } from '../domain/company.js';
import { envelope, responseFormat, untrustedText, type ToolDefinition } from './common.js';

const input = z.object({
  company_id: z.guid().optional().describe('Omit to list the companies these credentials can access.'),
  response_format: responseFormat,
});

export const companyOverview: ToolDefinition<typeof input> = {
  name: 'salary_company_overview',
  title: 'Company overview',
  description:
    'Start here. Without company_id: lists the Salary companies available, with their IDs. ' +
    'With company_id: company name and status, active payroll periods (aktive lønkørsler: periode, dispositionsdato, deadline, godkendt), ' +
    'and warnings from Salary grouped by severity. Use the returned company ID in every other salary_* tool.',
  inputSchema: input,
  outputSchema: envelope({
    companies: z.array(z.looseObject({ id: z.string(), name: z.string() })).optional(),
    company_details: z.looseObject({}).optional(),
    active_payrolls: z.array(z.looseObject({})).optional(),
    warnings: z.looseObject({}).optional(),
  }),
  maxRequests: 10,
  async run(args, ctx) {
    if (!args.company_id) {
      const companies = await authorizedCompanies(ctx);
      ctx.sections.companies = companies.length ? 'ok' : 'empty';
      return { company: null, data: { companies } };
    }
    const company = await requireCompany(ctx, args.company_id);
    const detail = await ctx.item('companies.get', CompanyDetail, { path: { companyID: company.id } });
    ctx.sections.company = 'ok';

    const active = await ctx.section('active_payrolls', () =>
      ctx.list('companies.activePayrolls', ActivePayroll, { path: { companyID: company.id } }).then((r) => r.items),
    );
    const warnings = await ctx.section('warnings', () =>
      ctx.listAll('warnings.list', Warning, { query: { companyID: company.id } }, { pageSize: 200, maxItems: 1000 }),
      (v) => v.items.length === 0,
    );

    const bySeverity: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const w of warnings?.items ?? []) {
      bySeverity[w.severityType ?? 'Unknown'] = (bySeverity[w.severityType ?? 'Unknown'] ?? 0) + 1;
      byType[w.warningType ?? 'Unknown'] = (byType[w.warningType ?? 'Unknown'] ?? 0) + 1;
    }

    return {
      company,
      data: {
        company_details: { id: detail.id, name: detail.name ?? company.name, state: detail.state ?? null, employee_count: detail.employeeCount ?? null },
        active_payrolls: (active ?? []).map((p) => ({
          period_start: p.periodStart ?? null,
          period_end: p.periodEnd ?? null,
          disposition_date: p.dispositionDate ?? null,
          deadline: p.deadline ?? null,
          frequency: p.frequency ?? null,
          approved: p.isApproved ?? null,
          rejected: p.isRejected ?? null,
        })),
        warnings: warnings
          ? {
              total: warnings.items.length,
              truncated: warnings.truncated,
              by_severity: bySeverity,
              by_type: byType,
              ...(args.response_format === 'detailed'
                ? {
                    items: warnings.items.slice(0, 100).map((w) => ({
                      type: w.warningType ?? null,
                      severity: w.severityType ?? null,
                      created_at: w.createdAt ?? null,
                      payroll_id: w.payRollID ?? null,
                      subject_id: w.subjectID ?? null,
                      parameter: untrustedText(w.parameter) ?? null,
                    })),
                  }
                : {}),
            }
          : null,
      },
    };
  },
};
