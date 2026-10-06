/**
 * Calendar semantics (SPEC §9): everything is a UTC unix timestamp computed here, in the client.
 * The contract never sees a date, only the resulting second. Unlock moment is 00:00 UTC.
 */
export const DAY = 86_400;

const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Seconds at 00:00 UTC of the given calendar date. `m` is 0-based. */
export const utcMidnight = (y: number, m: number, d: number): number => Date.UTC(y, m, d) / 1000;

/** Parses 'YYYY-MM-DD' strictly (no rolling over: 2025-02-30 is rejected). */
export function parseISODate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1]!, mo = +m[2]! - 1, d = +m[3]!;
  if (mo < 0 || mo > 11 || d < 1 || d > daysIn(y, mo)) return null;
  return utcMidnight(y, mo, d);
}

export const toISODate = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

/** Same calendar day `n` years later; Feb 29 falls back to Feb 28 in non-leap years. */
export function addYears(sec: number, n: number): number {
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear() + n, m = d.getUTCMonth();
  return utcMidnight(y, m, Math.min(d.getUTCDate(), daysIn(y, m)));
}

/** Same day-of-month `n` months later, clamped to the last day of shorter months (31 Jan + 1 mo = 28/29 Feb). */
export function addMonths(sec: number, n: number): number {
  const d = new Date(sec * 1000);
  const t = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(t / 12);
  const m = ((t % 12) + 12) % 12;
  return utcMidnight(y, m, Math.min(d.getUTCDate(), daysIn(y, m)));
}

/** `n` monthly dates starting at `start`, each computed from the START (so Jan 31 -> Feb 28 -> Mar 31, not Mar 28). */
export function monthlyDates(start: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => addMonths(start, i));
}

export function fmtDate(sec: number | bigint, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string {
  return new Date(Number(sec) * 1000).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

export const fmtShortDate = (sec: number | bigint): string => fmtDate(sec, { month: 'short', year: 'numeric' });

/** "8:00 pm" in the viewer's timezone, for the moment 00:00 UTC of that date. */
export function localTimeOfUnlock(sec: number | bigint): string {
  return new Date(Number(sec) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function ordinal(n: number): string {
  const v = n % 100;
  return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] ?? ['th', 'st', 'nd', 'rd'][v] ?? 'th');
}

export interface Span {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
}

/**
 * Calendar-aware span between two instants: the largest whole number of months that fits (month-end
 * clamped, UTC), then the remainder in days / hours / minutes / seconds.
 */
export function spanBetween(fromSec: number, toSec: number): Span {
  const total = Math.max(0, toSec - fromSec);
  const zero: Span = { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0, totalSeconds: total };
  if (total === 0) return zero;

  const dayStart = Math.floor(fromSec / DAY) * DAY;
  const tod = fromSec - dayStart; // time of day carried through the month arithmetic
  const a = new Date(fromSec * 1000), b = new Date(toSec * 1000);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  const anchor = (n: number) => addMonths(dayStart, n) + tod;
  while (months > 0 && anchor(months) > toSec) months--;

  const rem = toSec - anchor(months);
  return {
    years: Math.floor(months / 12),
    months: months % 12,
    days: Math.floor(rem / DAY),
    hours: Math.floor((rem % DAY) / 3600),
    minutes: Math.floor((rem % 3600) / 60),
    seconds: rem % 60,
    totalSeconds: total,
  };
}

/** "17 years, 4 months, 9 days" for far dates; "3 days, 4 hours" / "12 minutes" as it gets close. */
export function humanSpan(s: Span): string {
  const p = (n: number, w: string) => (n ? `${n} ${w}${n > 1 ? 's' : ''}` : '');
  if (s.totalSeconds <= 0) return 'now';
  if (s.years || s.months) return [p(s.years, 'year'), p(s.months, 'month'), p(s.days, 'day')].filter(Boolean).join(', ');
  if (s.days) return [p(s.days, 'day'), p(s.hours, 'hour')].filter(Boolean).join(', ');
  if (s.hours) return [p(s.hours, 'hour'), p(s.minutes, 'minute')].filter(Boolean).join(', ');
  if (s.minutes) return [p(s.minutes, 'minute'), p(s.seconds, 'second')].filter(Boolean).join(', ');
  return p(s.seconds, 'second');
}
