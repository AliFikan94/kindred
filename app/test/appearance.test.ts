import { describe, expect, it } from 'vitest';
import { applyAppearance, DEFAULT_APPEARANCE, loadAppearance, nextTheme, parseAppearance, saveAppearance } from '../src/appearance.js';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const fakeRoot = () => {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  } as unknown as HTMLElement & { attrs: Map<string, string> };
};

describe('appearance', () => {
  it('defaults to the classic look following the system theme', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE).toEqual({ theme: 'system', look: 'classic' });
  });

  it('round-trips through storage', () => {
    const s = mem();
    saveAppearance({ theme: 'dark', look: 'stationery' }, s);
    expect(loadAppearance(s, '')).toEqual({ theme: 'dark', look: 'stationery' });
  });

  it('ignores corrupt or hostile stored values field by field', () => {
    expect(parseAppearance('{ nope')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{"theme":"neon","look":"gothic"}')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{"theme":"dark","look":"gothic"}')).toEqual({ theme: 'dark', look: 'classic' });
    expect(parseAppearance('{"theme":["dark"],"look":null}')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('null')).toEqual(DEFAULT_APPEARANCE);
  });

  it('lets the URL override storage, but only with valid values', () => {
    expect(parseAppearance('{"theme":"light","look":"classic"}', '?look=stationery&theme=dark')).toEqual({ theme: 'dark', look: 'stationery' });
    expect(parseAppearance('{"theme":"light"}', '?theme=<script>&look=x')).toEqual({ theme: 'light', look: 'classic' });
  });

  it('never throws when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadAppearance(broken, '')).toEqual(DEFAULT_APPEARANCE);
    expect(() => saveAppearance({ theme: 'dark', look: 'classic' }, broken)).not.toThrow();
    expect(loadAppearance(null, '')).toEqual(DEFAULT_APPEARANCE);
  });

  it('applies attributes; "system" removes data-theme so the OS setting decides', () => {
    const r = fakeRoot();
    applyAppearance({ theme: 'dark', look: 'stationery' }, r);
    expect(r.attrs.get('data-theme')).toBe('dark');
    expect(r.attrs.get('data-look')).toBe('stationery');
    applyAppearance({ theme: 'system', look: 'classic' }, r);
    expect(r.attrs.has('data-theme')).toBe(false);
    expect(r.attrs.get('data-look')).toBe('classic');
  });

  it('cycles system -> light -> dark -> system', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });
});
