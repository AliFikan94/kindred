import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { fmtMon, parseAddress, parseAddressList, parseMon, shortAddr } from '../src/lib/format.js';
import { decodeMeta, encodeMeta, Meta, scheduleLink } from '../src/lib/share.js';
import { buildIcs } from '../src/lib/ics.js';
import { friendlyError, UserError } from '../src/lib/errors.js';
import { NET_APY, worthAt } from '../src/lib/projection.js';

describe('MON formatting', () => {
  it('formats without exponents or float noise', () => {
    expect(fmtMon(5000n * 10n ** 18n)).toBe('5,000');
    expect(fmtMon(10n ** 17n)).toBe('0.1');
    expect(fmtMon(1_234_567_800_000_000_000_000n)).toBe('1,234.5678');
    expect(fmtMon(1n)).toBe('0');
    expect(fmtMon(0n)).toBe('0');
    expect(fmtMon(-(10n ** 18n))).toBe('-1');
    expect(fmtMon(10n ** 30n)).toBe('1,000,000,000,000');
  });
  it('parses strictly', () => {
    expect(parseMon('5000')).toBe(5000n * 10n ** 18n);
    expect(parseMon(' 0.000000000000000001 ')).toBe(1n);
    for (const bad of ['', '0', '0.0', '-1', '1e3', '1,000', '0.0000000000000000001', 'abc', '1.', '.5', '1 2']) expect(parseMon(bad), bad).toBeNull();
  });
  it('shortens addresses', () => expect(shortAddr('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678'));
});

describe('addresses', () => {
  const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  it('accepts any-case, returns checksummed, rejects zero and junk', () => {
    expect(parseAddress(A.toLowerCase())).toBe(A);
    expect(parseAddress(' ' + A + ' ')).toBe(A);
    expect(parseAddress('0x' + '0'.repeat(40))).toBeNull();
    for (const bad of ['', '0x123', 'hello', A.slice(0, 41), A + '0']) expect(parseAddress(bad), bad).toBeNull();
  });
  it('splits lists on commas, spaces and newlines and reports every bad token', () => {
    const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    const r = parseAddressList(`${A}, ${B}\nnope ${A.toLowerCase()};0x12`);
    expect(r.ok).toEqual([A, B, A]);
    expect(r.bad).toEqual(['nope', '0x12']);
  });
});

describe('share links', () => {
  const m: Meta = { v: 1, preset: 'family', label: 'Maya', moment: '18th birthday', note: 'We are so proud of you. 💛 ünïcode', from: 'Mum' };
  it('round-trips, including unicode', () => expect(decodeMeta(encodeMeta(m))).toEqual(m));
  it('is URL-safe and compact', () => {
    const e = encodeMeta(m);
    expect(e).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(e.length).toBeLessThan(400);
  });
  it('drops fields it should not carry and caps long strings', () => {
    const e = encodeMeta({ ...m, note: 'x'.repeat(5000), label: 'L'.repeat(500) });
    const d = decodeMeta(e)!;
    expect(d.note!.length).toBe(280);
    expect(d.label.length).toBe(40);
  });
  it('strips control characters', () => {
    const d = decodeMeta(encodeMeta({ ...m, note: 'a\u0000b\nc\u007fd' }))!;
    expect(d.note).toBe('a b c d');
  });
  it('rejects tampered or hostile input without throwing', () => {
    for (const bad of [null, undefined, '', '!!!', 'a'.repeat(5000), 'e30', 'bm90anNvbg', btoa(JSON.stringify({ v: 2, preset: 'family', label: 'x' })), btoa(JSON.stringify({ v: 1, preset: 'evil', label: 'x' })), btoa(JSON.stringify({ v: 1, preset: 'family' }))]) {
      expect(decodeMeta(bad as never), String(bad)).toBeNull();
    }
  });
  it('ignores non-string and malformed optional fields, and malformed keys', () => {
    const raw = btoa(JSON.stringify({ v: 1, preset: 'pay', label: 'Sam', note: 5, key: '0x12', from: ['x'] })).replace(/=+$/, '');
    expect(decodeMeta(raw)).toEqual({ v: 1, preset: 'pay', label: 'Sam' });
  });
  it('carries a valid claim key only', () => {
    const key = ('0x' + '11'.repeat(32)) as `0x${string}`;
    expect(decodeMeta(encodeMeta({ ...m, key }))!.key).toBe(key);
    expect(decodeMeta(encodeMeta({ ...m, key: '0xabc' as never }))!.key).toBeUndefined();
    expect(privateKeyToAccount(key).address).toMatch(/^0x/);
  });
  it('builds a fragment link', () => {
    expect(scheduleLink('https://k.app', '0xabc', m)).toMatch(/^https:\/\/k\.app\/#\/s\/0xabc\?m=[A-Za-z0-9_-]+$/);
    expect(scheduleLink('https://k.app', '0xabc')).toBe('https://k.app/#/s/0xabc');
  });
});

describe('ics', () => {
  const ics = buildIcs([{ uid: 'a-1@kindred', day: Date.UTC(2038, 5, 8) / 1000, summary: 'Kindred: 5,000 MON arrives for Maya', description: 'Sent automatically; nothing to do.\nLove, Mum' }], 1_700_000_000);
  it('is a well-formed calendar with CRLF endings', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(ics).toContain('DTSTART;VALUE=DATE:20380608');
    expect(ics).toContain('DTEND;VALUE=DATE:20380609');
    expect(ics).toContain('DTSTAMP:20231114T221320Z');
  });
  it('escapes TEXT per RFC 5545', () => {
    expect(ics).toContain('SUMMARY:Kindred: 5\\,000 MON arrives for Maya');
    expect(ics).toContain('DESCRIPTION:Sent automatically\; nothing to do.\\nLove\\, Mum');
  });
  it('folds lines longer than 75 octets without splitting a character', () => {
    const long = buildIcs([{ uid: 'u', day: 0, summary: 'é'.repeat(100) }], 0);
    for (const line of long.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(long.replace(/\r\n /g, '')).toContain('é'.repeat(100));
  });
  it('year-end rolls DTEND into the next year', () => {
    expect(buildIcs([{ uid: 'u', day: Date.UTC(2030, 11, 31) / 1000, summary: 's' }], 0)).toContain('DTEND;VALUE=DATE:20310101');
  });
});

describe('errors', () => {
  it('maps contract errors, wallet rejections and money problems', () => {
    expect(friendlyError({ cause: { data: { errorName: 'TimelockActive' } } })).toMatch(/7-day/);
    expect(friendlyError({ code: 4001, message: 'x' })).toMatch(/cancelled/);
    expect(friendlyError(new Error('User rejected the request.'))).toMatch(/cancelled/);
    expect(friendlyError(new Error('insufficient funds for gas * price + value'))).toMatch(/enough balance/);
    expect(friendlyError(new Error('Execution reverted with reason: Out of gas: gas required exceeds allowance: 0.'))).toMatch(/network fee/);
    expect(friendlyError(new UserError('Pick a date.'))).toBe('Pick a date.');
  });
  it('never hides an unknown error, but keeps it short', () => {
    expect(friendlyError(new Error('weird thing'))).toBe('weird thing');
    expect(friendlyError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(140);
  });
});

describe('projection', () => {
  it('uses 5% gross minus the 10% share', () => expect(NET_APY).toBeCloseTo(0.045, 10));
  const Y = 365.25 * 86_400;
  it('compounds a single slice and shows nothing waiting after it unlocks', () => {
    const s = [{ t: 10 * Y, amount: 1000 }];
    expect(worthAt(0, s, 0, true).total).toBeCloseTo(1000, 6);
    expect(worthAt(10 * Y, s, 0, true).total).toBeCloseTo(1000 * 1.045 ** 10, 6);
    expect(worthAt(10 * Y, s, 0, true).waiting).toBe(0);
    expect(worthAt(11 * Y, s, 0, true).arrived).toBeCloseTo(1000 * 1.045 ** 10, 6); // stops growing once delivered
  });
  it('is flat without growth', () => {
    expect(worthAt(5 * Y, [{ t: 10 * Y, amount: 1000 }], 0, false).total).toBe(1000);
  });
  it('splits arrived from waiting across several slices', () => {
    const w = worthAt(2.5 * Y, [{ t: Y, amount: 100 }, { t: 2 * Y, amount: 100 }, { t: 3 * Y, amount: 100 }], 0, false);
    expect([w.arrived, w.waiting, w.principal]).toEqual([200, 100, 300]);
  });
});
