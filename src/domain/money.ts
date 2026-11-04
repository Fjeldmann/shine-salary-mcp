/**
 * Salary returns amounts as decimal numbers in DKK. Sums are computed in
 * integer øre so floating-point drift never reaches a total.
 */
export const CURRENCY = 'DKK';

export const toOre = (amount: number): number => Math.round(amount * 100);
export const fromOre = (ore: number): number => ore / 100;

export function sumAmounts(amounts: Array<number | null | undefined>): number {
  return fromOre(amounts.reduce<number>((acc, a) => acc + (typeof a === 'number' && Number.isFinite(a) ? toOre(a) : 0), 0));
}

export function sumHours(values: Array<number | null | undefined>): number {
  return Math.round(values.reduce<number>((acc, v) => acc + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0) * 100) / 100;
}
