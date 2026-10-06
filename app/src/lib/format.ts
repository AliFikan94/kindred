import { formatEther, getAddress, isAddress, parseEther } from 'viem';

export type Address = `0x${string}`;

/** "5,000" / "0.25" / "1,234.5678": trims trailing zeros, groups thousands, never shows exponent notation. */
export function fmtMon(wei: bigint, maxDecimals = 4): string {
  const neg = wei < 0n;
  const [int = '0', frac = ''] = formatEther(neg ? -wei : wei).split('.');
  const f = frac.slice(0, maxDecimals).replace(/0+$/, '');
  const i = BigInt(int).toLocaleString('en-US');
  return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`;
}

/** Strict MON amount: digits with at most 18 decimals, > 0. Returns null if invalid. */
export function parseMon(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const v = parseEther(t);
  return v > 0n ? v : null;
}

export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Accepts any-case hex addresses; rejects the zero address; returns the checksummed form. */
export function parseAddress(s: string): Address | null {
  const t = s.trim();
  if (!isAddress(t, { strict: false })) return null;
  const a = getAddress(t.toLowerCase());
  return /^0x0{40}$/.test(a) ? null : (a as Address);
}

/** Splits free text (commas, spaces, newlines) into addresses; reports every token that is not one. */
export function parseAddressList(s: string): { ok: Address[]; bad: string[] } {
  const ok: Address[] = [];
  const bad: string[] = [];
  for (const tok of s.split(/[\s,;]+/).filter(Boolean)) {
    const a = parseAddress(tok);
    if (a) ok.push(a);
    else bad.push(tok);
  }
  return { ok, bad };
}
