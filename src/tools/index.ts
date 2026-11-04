import { companyOverview } from './company-overview.js';
import type { ToolDefinition } from './common.js';
import { employeeSummary, findEmployees } from './employees.js';
import { payrollOverview } from './payroll.js';
import { payslipSummary } from './payslips.js';
import { timeSummary } from './time.js';

/** Registration order is the order clients see. Keep it fixed. */
export const TOOLS: readonly ToolDefinition[] = [
  companyOverview,
  findEmployees,
  employeeSummary,
  payrollOverview,
  payslipSummary,
  timeSummary,
] as unknown as readonly ToolDefinition[];
