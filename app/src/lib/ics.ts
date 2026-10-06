import { toISODate } from './dates.js';

export interface IcsEvent {
  uid: string;
  /** Unix seconds of 00:00 UTC of the day it arrives. */
  day: number;
  summary: string;
  description?: string;
}

/** RFC 5545 TEXT escaping. */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds a content line to 75 octets, continuing with a leading space, as the RFC requires. */
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > (out.length === 0 ? 75 : 74)) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const ymd = (sec: number): string => toISODate(sec).replace(/-/g, '');

export function buildIcs(events: IcsEvent[], nowSec = Math.floor(Date.now() / 1000), prodId = '-//Kindred//Schedule//EN'): string {
  const stamp = new Date(nowSec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN'];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(e.day)}`,
      `DTEND;VALUE=DATE:${ymd(e.day + 86_400)}`,
      `SUMMARY:${esc(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
