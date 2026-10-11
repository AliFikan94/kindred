import { useEffect, useState } from 'react';
import { applyAppearance, Appearance as A, loadAppearance, nextTheme, saveAppearance } from '../appearance.js';

const THEME_LABEL = { system: 'Auto', light: 'Light', dark: 'Dark' } as const;
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' } as const;

/** One button: Auto → Light → Dark. */
export function Appearance() {
  const [a, setA] = useState<A>(() => loadAppearance());
  useEffect(() => { applyAppearance(a); saveAppearance(a); }, [a]);
  return (
    <button
      className="pill"
      onClick={() => setA((x) => ({ ...x, theme: nextTheme(x.theme) }))}
      aria-label={`Colour theme: ${THEME_LABEL[a.theme]}. Press to change.`}
      title="Colour theme"
    >
      <span aria-hidden="true">{THEME_ICON[a.theme]}</span> {THEME_LABEL[a.theme]}
    </button>
  );
}
