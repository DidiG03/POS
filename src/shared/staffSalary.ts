export const SALARY_PERIODS = ['HOURLY', 'MONTHLY', 'YEARLY'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export function parseSalaryPeriod(raw: unknown): SalaryPeriod | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase();
  return (SALARY_PERIODS as readonly string[]).includes(s)
    ? (s as SalaryPeriod)
    : null;
}

export function parseSalaryAmountInput(
  raw: string,
): { ok: true; value: number | null } | { ok: false } {
  const s = raw.trim().replace(',', '.');
  if (!s) return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

export function salaryFromUser(u: {
  salaryAmount?: unknown;
  salaryPeriod?: unknown;
}): { salaryAmount: number | null; salaryPeriod: SalaryPeriod | null } {
  const amount = u.salaryAmount != null ? Number(u.salaryAmount) : null;
  return {
    salaryAmount: Number.isFinite(amount as number) ? amount : null,
    salaryPeriod: parseSalaryPeriod(u.salaryPeriod),
  };
}

/** Empty amount clears both fields. Amount without a period defaults to monthly. */
export function salaryWriteData(
  amount: number | null,
  period: SalaryPeriod | null,
): { salaryAmount: number | null; salaryPeriod: SalaryPeriod | null } {
  if (amount == null) return { salaryAmount: null, salaryPeriod: null };
  return { salaryAmount: amount, salaryPeriod: period ?? 'MONTHLY' };
}

export function salaryAmountInputValue(
  amount: number | null | undefined,
): string {
  return amount == null ? '' : String(amount);
}
