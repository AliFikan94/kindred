import { describe, expect, it } from 'vitest';
import { addMonths, addYears, DAY, fmtDate, humanSpan, monthlyDates, ordinal, parseISODate, spanBetween, toISODate, utcMidnight } from '../src/lib/dates.js';

const d = (s: string) => parseISODate(s)!;

describe('parseISODate', () => {
  it('accepts real dates and returns UTC midnight', () => {
    expect(d('2038-06-08')).toBe(Date.UTC(2038, 5, 8) / 1000);
    expect(d('2024-02-29')).toBe(Date.UTC(2024, 1, 29) / 1000);
  });
  it('rejects impossible or malformed dates instead of rolling them over', () => {
    for (const bad of ['2025-02-29', '2025-02-30', '2025-13-01', '2025-00-10', '2025-04-31', '25-01-01', '2025/01/01', '', 'garbage']) {
      expect(parseISODate(bad), bad).toBeNull();
    }
  });
  it('round-trips through toISODate', () => {
    expect(toISODate(d('1999-12-31'))).toBe('1999-12-31');
  });
});

describe('addYears', () => {
  it('keeps the calendar day', () => expect(toISODate(addYears(d('2020-06-08'), 18))).toBe('2038-06-08'));
  it('Feb 29 birthdays resolve to Feb 28 in non-leap years, and stay Feb 29 in leap years', () => {
    expect(toISODate(addYears(d('2004-02-29'), 18))).toBe('2022-02-28');
    expect(toISODate(addYears(d('2004-02-29'), 20))).toBe('2024-02-29');
    expect(toISODate(addYears(d('2008-02-29'), 21))).toBe('2029-02-28');
  });
  it('does not drift across a century leap-year exception', () => {
    expect(toISODate(addYears(d('1896-02-29'), 4))).toBe('1900-02-28'); // 1900 is not a leap year
  });
});

describe('addMonths / monthlyDates', () => {
  it('clamps to the last day of shorter months', () => {
    expect(toISODate(addMonths(d('2025-01-31'), 1))).toBe('2025-02-28');
    expect(toISODate(addMonths(d('2024-01-31'), 1))).toBe('2024-02-29');
    expect(toISODate(addMonths(d('2025-03-31'), 1))).toBe('2025-04-30');
  });
  it('crosses year boundaries both ways', () => {
    expect(toISODate(addMonths(d('2025-11-15'), 3))).toBe('2026-02-15');
    expect(toISODate(addMonths(d('2025-02-15'), -3))).toBe('2024-11-15');
  });
  it('computes each payment from the start date, so the day does not creep down', () => {
    expect(monthlyDates(d('2025-01-31'), 4).map(toISODate)).toEqual(['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30']);
  });
  it('produces strictly increasing dates', () => {
    const ds = monthlyDates(d('2025-01-29'), 24);
    for (let i = 1; i < ds.length; i++) expect(ds[i]!).toBeGreaterThan(ds[i - 1]!);
  });
});

describe('ordinal', () => {
  it.each([[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [18, '18th'], [21, '21st'], [22, '22nd'], [23, '23rd'], [30, '30th'], [101, '101st'], [111, '111th']])('%i -> %s', (n, s) => {
    expect(ordinal(n)).toBe(s);
  });
});

describe('fmtDate', () => {
  it('formats in UTC regardless of the viewer timezone', () => {
    expect(fmtDate(d('2038-06-08'))).toBe('8 June 2038');
    expect(fmtDate(d('2038-06-08') + DAY - 1)).toBe('8 June 2038'); // last second of the day is still that day
  });
});

describe('spanBetween / humanSpan', () => {
  const at = (s: string, secs = 0) => d(s) + secs;
  it('counts whole years, months and days', () => {
    const s = spanBetween(at('2026-10-06'), at('2043-02-15'));
    expect([s.years, s.months, s.days]).toEqual([16, 4, 9]);
    expect(humanSpan(s)).toBe('16 years, 4 months, 9 days');
  });
  it('agrees with the payment calendar at month ends: 31 Jan + 1 month = 28 Feb, so that span is one month', () => {
    const exact = spanBetween(at('2025-01-31'), at('2025-02-28'));
    expect([exact.years, exact.months, exact.days]).toEqual([0, 1, 0]);
    const dayBefore = spanBetween(at('2025-01-31'), at('2025-02-27'));
    expect([dayBefore.months, dayBefore.days]).toEqual([0, 27]); // one day short of the next monthly date
    const dayAfter = spanBetween(at('2025-01-31'), at('2025-03-01'));
    expect([dayAfter.months, dayAfter.days]).toEqual([1, 1]);
  });
  it('does not overshoot: one second before an anniversary is 11 months', () => {
    const s = spanBetween(at('2025-03-10'), at('2026-03-10', -1));
    expect([s.years, s.months]).toEqual([0, 11]);
  });
  it('switches to finer units as it gets close', () => {
    expect(humanSpan(spanBetween(1000, 1000 + 3 * DAY + 4 * 3600))).toBe('3 days, 4 hours');
    expect(humanSpan(spanBetween(1000, 1000 + 2 * 3600 + 5 * 60))).toBe('2 hours, 5 minutes');
    expect(humanSpan(spanBetween(1000, 1000 + 125))).toBe('2 minutes, 5 seconds');
    expect(humanSpan(spanBetween(1000, 1000 + 7))).toBe('7 seconds');
    expect(humanSpan(spanBetween(1000, 1000))).toBe('now');
    expect(humanSpan(spanBetween(2000, 1000))).toBe('now'); // never negative
  });
  it('totals are consistent for random pairs', () => {
    for (let i = 0; i < 300; i++) {
      const a = 1_700_000_000 + Math.floor(Math.random() * 5e8);
      const b = a + Math.floor(Math.random() * 6e8);
      const s = spanBetween(a, b);
      expect(s.days).toBeGreaterThanOrEqual(0);
      expect(s.days).toBeLessThan(32);
      expect(s.months).toBeLessThan(12);
      expect(s.hours).toBeLessThan(24);
      expect(s.minutes).toBeLessThan(60);
      expect(s.seconds).toBeLessThan(60);
      expect(s.totalSeconds).toBe(b - a);
    }
  });
});

describe('utcMidnight', () => {
  it('matches Date.UTC', () => expect(utcMidnight(2030, 0, 1)).toBe(Date.UTC(2030, 0, 1) / 1000));
});
