import type { FilterCond } from "@confire/db";

// Relative dates in a report's filters (reports spec §3.1): `@today`, `@today-12M`, `@startOfMonth`,
// `@startOfYear-1Y`… resolved when the report runs, so a saved "last 12 months" never freezes. In UTC,
// as `YYYY-MM-DD`; weeks start on Monday. A value that is not a token passes untouched.

const TOKEN = /^@(today|startOfWeek|startOfMonth|startOfQuarter|startOfYear)(?:([+-])(\d+)([DWMY]))?$/;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Months from (y, m, d), the day clamped to the month's last (31 March − 1 month = 28 February). */
const addMonths = (y: number, m: number, d: number, k: number): Date => {
  const first = new Date(Date.UTC(y, m + k, 1));
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, daysIn(first.getUTCFullYear(), first.getUTCMonth()))));
};

export function resolveDate(token: string, today: Date): string {
  const t = TOKEN.exec(token);
  if (!t) return token;
  const [, base, sign, n, unit] = t;
  let y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate();
  if (base === "startOfWeek") d -= (today.getUTCDay() + 6) % 7;
  if (base === "startOfMonth") d = 1;
  if (base === "startOfQuarter") { m -= m % 3; d = 1; }
  if (base === "startOfYear") { m = 0; d = 1; }
  let at = new Date(Date.UTC(y, m, d));
  if (n) {
    const k = (sign === "-" ? -1 : 1) * Number(n);
    [y, m, d] = [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()];
    at = unit === "D" ? new Date(Date.UTC(y, m, d + k))
      : unit === "W" ? new Date(Date.UTC(y, m, d + 7 * k))
      : addMonths(y, m, d, unit === "M" ? k : 12 * k);
  }
  return iso(at);
}

const one = <T>(v: T, today: Date): T => (typeof v === "string" ? resolveDate(v, today) as T : v);

export const resolveFilter = (filter: FilterCond[], today: Date): FilterCond[] =>
  filter.map((c) => ({ ...c, value: Array.isArray(c.value) ? c.value.map((v) => one(v, today)) : one(c.value, today) }));
