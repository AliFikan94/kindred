/**
 * How the app looks: a colour theme (follows the system by default) and a visual "look".
 * Stored on this device only, and applied as attributes on <html>, so the stylesheet does the rest.
 * A URL like  ?look=stationery&theme=dark  also works, for links and screenshots.
 */
export type Theme = 'system' | 'light' | 'dark';
export type Look = 'classic' | 'stationery';
export interface Appearance {
  theme: Theme;
  look: Look;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', look: 'classic' };
const KEY = 'kindred:appearance';

const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark';
const isLook = (v: unknown): v is Look => v === 'classic' || v === 'stationery';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Strict: anything unexpected falls back to the default for that field, never throws. */
export function parseAppearance(raw: string | null | undefined, search = ''): Appearance {
  const out: Appearance = { ...DEFAULT_APPEARANCE };
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (isTheme(o.theme)) out.theme = o.theme;
    if (isLook(o.look)) out.look = o.look;
  } catch { /* corrupt value: use defaults */ }
  const q = new URLSearchParams(search);
  const t = q.get('theme'), l = q.get('look');
  if (isTheme(t)) out.theme = t;
  if (isLook(l)) out.look = l;
  return out;
}

export function loadAppearance(store: Store | null = safeStorage(), search = typeof location !== 'undefined' ? location.search : ''): Appearance {
  let raw: string | null = null;
  try { raw = store?.getItem(KEY) ?? null; } catch { /* private mode */ }
  return parseAppearance(raw, search);
}

export function saveAppearance(a: Appearance, store: Store | null = safeStorage()): void {
  try { store?.setItem(KEY, JSON.stringify(a)); } catch { /* best effort */ }
}

/** 'system' leaves data-theme off, so the stylesheet's prefers-color-scheme rules decide. */
export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  if (a.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', a.theme);
  root.setAttribute('data-look', a.look);
}

export const nextTheme = (t: Theme): Theme => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system');

function safeStorage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
