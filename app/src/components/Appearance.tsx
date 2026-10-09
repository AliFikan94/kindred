import { useEffect, useState } from 'react';
import { applyAppearance, Appearance as A, loadAppearance, Look, nextTheme, saveAppearance } from '../appearance.js';

const THEME_LABEL = { system: 'Auto', light: 'Light', dark: 'Dark' } as const;
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' } as const;

/**
 * Light / dark, and (while we are choosing) the two looks side by side.
 * Once a look is chosen, delete the `looks` group and keep the theme button.
 */
export function Appearance() {
  const [a, setA] = useState<A>(() => loadAppearance());
  useEffect(() => { applyAppearance(a); saveAppearance(a); }, [a]);
  const look = (l: Look) => setA((x) => ({ ...x, look: l }));

  return (
    <div className="appearance" role="group" aria-label="Appearance">
      <span className="looks" role="group" aria-label="Look">
        <button className="mini" aria-pressed={a.look === 'classic'} onClick={() => look('classic')}>Classic</button>
        <button className="mini" aria-pressed={a.look === 'stationery'} onClick={() => look('stationery')}>Stationery</button>
      </span>
      <button
        className="mini"
        onClick={() => setA((x) => ({ ...x, theme: nextTheme(x.theme) }))}
        aria-label={`Colour theme: ${THEME_LABEL[a.theme]}. Press to change.`}
        title="Colour theme"
      >
        <span aria-hidden="true">{THEME_ICON[a.theme]}</span> {THEME_LABEL[a.theme]}
      </button>
    </div>
  );
}
