import { z } from 'zod';
import { SalaryError } from '../errors.js';

/**
 * Reviewed response schemas. Objects are loose: Salary may add fields at any
 * time (spec versioning policy), and unknown enum values must not break
 * parsing, so enums are plain strings here and interpreted by tools.
 */

export const Pagination = z.looseObject({
  offset: z.number().optional(),
  count: z.number().optional(),
  totalCount: z.number().optional(),
});

export function listEnvelope<T extends z.ZodType>(item: T) {
  return z.looseObject({ data: z.array(item), pagination: Pagination.optional() });
}

export function itemEnvelope<T extends z.ZodType>(item: T) {
  return z.looseObject({ data: item });
}

export const Company = z.looseObject({
  id: z.guid(),
  name: z.string(),
});
export type Company = z.infer<typeof Company>;

/** `/v2/apiKeys` (undocumented): only the fields `status --check` reads. The key value is never parsed. */
export const ApiKeyInfo = z.looseObject({
  id: z.string(),
  companyID: z.guid(),
  description: z.string().nullish(),
  scopes: z.array(z.string()),
  createdAt: z.string().optional(),
});
export type ApiKeyInfo = z.infer<typeof ApiKeyInfo>;

export const CompaniesResponse = listEnvelope(Company);
export const ApiKeysResponse = listEnvelope(ApiKeyInfo);

/**
 * Scope names verified to be read-only. Only `ReadAll` has been observed
 * (2026-11-04); the narrower read scopes' API names are unknown, so any other
 * value makes `status --check` ask the user to confirm it in Salary's UI.
 */
export const VERIFIED_READ_ONLY_SCOPES: ReadonlySet<string> = new Set(['ReadAll']);

export function parseResponse<T extends z.ZodType>(schema: T, body: unknown, endpoint: string): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    // Report paths only: issue messages can echo values.
    const paths = result.error.issues
      .slice(0, 5)
      .map((i) => i.path.join('.') || '(root)')
      .join(', ');
    throw new SalaryError('BAD_RESPONSE', `Unexpected response shape from ${endpoint} at: ${paths}.`, { endpoint });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Item schemas used by the v1 tools. Field lists follow swagger.json and the
// live shapes observed on 2026-11-04. Only fields the tools read are listed;
// everything except `id` is nullish so a missing field never breaks a tool.
// ---------------------------------------------------------------------------

const str = z.string().nullish();
const num = z.number().nullish();
const bool = z.boolean().nullish();

export const CompanyDetail = z.looseObject({
  id: z.guid(),
  name: str,
  state: str,
  employeeCount: num,
});

export const ActivePayroll = z.looseObject({
  periodStart: str,
  periodEnd: str,
  dispositionDate: str,
  deadline: str,
  frequency: str,
  isApproved: bool,
  isRejected: bool,
});

export const Warning = z.looseObject({
  id: z.string(),
  warningType: str,
  severityType: str,
  createdAt: str,
  payRollID: str,
  subjectID: str,
  parameter: z.unknown().optional(),
});

export const Employment = z.looseObject({
  id: z.string(),
  employeeID: str,
  employeeNumber: str,
  startDate: str,
  endDate: str,
  incomeType: str,
  preferredTaxCardType: str,
  settled: bool,
});

const RemunerationSalary = z.looseObject({ title: str, rate: num, quantity: num, salaryTypeID: str });
const RemunerationPension = z.looseObject({ title: str, scheme: str, percentage: num, fixedAmount: num });
const RemunerationBenefit = z.looseObject({ type: str, title: str, amount: num });
const RemunerationSupplement = z.looseObject({ compensationRate: num, typeID: str });
export const Remuneration = z.looseObject({
  salary: z.array(RemunerationSalary).nullish(),
  pension: z.array(RemunerationPension).nullish(),
  benefits: z.array(RemunerationBenefit).nullish(),
  supplements: z.array(RemunerationSupplement).nullish(),
});

export const Contract = z.looseObject({
  id: z.string(),
  companyID: str,
  employeeID: str,
  employmentID: str,
  validFrom: str,
  validTo: str,
  position: str,
  employmentType: str,
  remunerationType: str,
  weeklyHours: num,
  weeklyWorkDays: num,
  cachedSalaryAmount: num,
  remuneration: Remuneration.nullish(),
});

export const Employee = z.looseObject({
  id: z.guid(),
  companyID: str,
  name: str,
  employmentStatus: str,
  affiliationType: str,
  departmentID: str,
  activeEmployment: Employment.nullish(),
  activeContract: Contract.nullish(),
});
export type Employee = z.infer<typeof Employee>;

export const Department = z.looseObject({ id: z.string(), name: str });

export const PayRoll = z.looseObject({
  id: z.guid(),
  companyID: str,
  payRollType: str,
  status: str,
  dispositionDate: str,
  isApproved: bool,
  isRejected: bool,
  isTentative: bool,
  isReviewed: bool,
  salaryPeriod: z.looseObject({ start: str, end: str }).nullish(),
  salaryCycle: z.looseObject({ frequency: str }).nullish(),
  totalPaycheck: num,
  totalTransfer: num,
  totalInvoice: num,
  totalHours: num,
});
export type PayRoll = z.infer<typeof PayRoll>;

export const PayRollDeviation = z.looseObject({
  id: z.string(),
  employeeID: str,
  type: str,
  valueBefore: num,
  valueAfter: num,
});

export const Transfer = z.looseObject({
  id: z.string(),
  type: str,
  amount: num,
  paymentDate: str,
  state: str,
  paymentMethod: str,
  employeeID: str,
});

const CalculationRow = z.looseObject({ row: num, title: str, units: num, rate: num, amount: num });
export const PaySlip = z.looseObject({
  id: z.guid(),
  employeeID: str,
  payRollID: str,
  dispositionDate: str,
  payCheck: num,
  settled: bool,
  termination: bool,
  salaryPeriod: z.looseObject({ start: str, end: str }).nullish(),
  aggregates: z.array(z.looseObject({ accountType: str, sum: num })).nullish(),
  calculations: z.array(z.looseObject({ type: str, result: num, rows: z.array(CalculationRow).nullish() })).nullish(),
});
export type PaySlip = z.infer<typeof PaySlip>;

export const TimeRegistration = z.looseObject({
  id: z.string(),
  employeeID: str,
  date: str,
  class: str,
  hours: num,
  days: num,
  minutes: num,
  leaveTypeID: str,
  state: str,
  approved: bool,
  note: str,
});

export const LeaveType = z.looseObject({ id: z.string(), name: str, class: str, unit: str });
