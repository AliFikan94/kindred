/**
 * Off-chain labels travel in the share link's #fragment, which browsers never send to a server.
 * The chain only ever sees addresses, amounts and timestamps (SPEC §11). A link is untrusted input:
 * decoding is strict, size-limited and every string is capped and stripped of control characters.
 */
export type PresetKey = 'family' | 'pay' | 'drop';

export interface Meta {
  v: 1;
  preset: PresetKey;
  /** Who it is for ("Maya", "Sam", "Design Guild"). */
  label: string;
  /** Moment ("18th birthday"). */
  moment?: string;
  /** Note to open with the gift. */
  note?: string;
  /** From ("Mum"). */
  from?: string;
  /** Claim-link key for a recipient with no wallet yet. Treat like a password. */
  key?: `0x${string}`;
}

const MAX = { label: 40, moment: 40, note: 280, from: 40 };
const MAX_ENCODED = 4096;

const clean = (s: unknown, max: number): string | undefined => {
  if (typeof s !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return t || undefined;
};

export function encodeMeta(m: Meta): string {
  const body: Meta = { v: 1, preset: m.preset, label: clean(m.label, MAX.label) ?? '' };
  const moment = clean(m.moment, MAX.moment), note = clean(m.note, MAX.note), from = clean(m.from, MAX.from);
  if (moment) body.moment = moment;
  if (note) body.note = note;
  if (from) body.from = from;
  if (m.key && /^0x[0-9a-fA-F]{64}$/.test(m.key)) body.key = m.key;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeMeta(s: string | null | undefined): Meta | null {
  if (!s || s.length > MAX_ENCODED || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (o.v !== 1 || (o.preset !== 'family' && o.preset !== 'pay' && o.preset !== 'drop')) return null;
    const label = clean(o.label, MAX.label);
    if (!label) return null;
    const m: Meta = { v: 1, preset: o.preset, label };
    const moment = clean(o.moment, MAX.moment), note = clean(o.note, MAX.note), from = clean(o.from, MAX.from);
    if (moment) m.moment = moment;
    if (note) m.note = note;
    if (from) m.from = from;
    if (typeof o.key === 'string' && /^0x[0-9a-fA-F]{64}$/.test(o.key)) m.key = o.key as `0x${string}`;
    return m;
  } catch {
    return null;
  }
}

/** `#/s/<vault>` plus `?m=<meta>` (kept inside the fragment, so it is never sent to the server). */
export function scheduleLink(origin: string, vault: string, meta?: Meta): string {
  const m = meta ? `?m=${encodeMeta(meta)}` : '';
  return `${origin.replace(/\/+$/, '')}/#/s/${vault}${m}`;
}
