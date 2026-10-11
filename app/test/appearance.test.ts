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
  it('defaults to following the system theme', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE).toEqual({ theme: 'system' });
  });

  it('round-trips through storage', () => {
    const s = mem();
    saveAppearance({ theme: 'dark' }, s);
    expect(loadAppearance(s, '')).toEqual({ theme: 'dark' });
  });

  it('ignores corrupt or hostile stored values field by field', () => {
    expect(parseAppearance('{ nope')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{"theme":"neon"}')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('{"theme":"dark","look":"classic"}')).toEqual({ theme: 'dark' }); // old stored look is ignored
    expect(parseAppearance('{"theme":["dark"]}')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance('null')).toEqual(DEFAULT_APPEARANCE);
  });

  it('lets the URL override storage, but only with valid values', () => {
    expect(parseAppearance('{"theme":"light","look":"classic"}', '?look=stationery&theme=dark')).toEqual({ theme: 'dark' });
    expect(parseAppearance('{"theme":"light"}', '?theme=<script>')).toEqual({ theme: 'light' });
  });

  it('never throws when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadAppearance(broken, '')).toEqual(DEFAULT_APPEARANCE);
    expect(() => saveAppearance({ theme: 'dark' }, broken)).not.toThrow();
    expect(loadAppearance(null, '')).toEqual(DEFAULT_APPEARANCE);
  });

  it('applies the theme attribute; "system" removes data-theme so the OS setting decides', () => {
    const r = fakeRoot();
    applyAppearance({ theme: 'dark' }, r);
    expect(r.attrs.get('data-theme')).toBe('dark');
    applyAppearance({ theme: 'system' }, r);
    expect(r.attrs.has('data-theme')).toBe(false);
  });

  it('cycles system -> light -> dark -> system', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });
});
