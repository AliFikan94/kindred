import { ReactNode } from 'react';

export function Chips<T extends string | number>({ items, value, onChange, label, disabled }: {
  items: Array<[T, string]>;
  value: T;
  onChange(v: T): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {items.map(([v, t]) => (
        <button key={String(v)} type="button" className="chip" aria-pressed={v === value} disabled={disabled} onClick={() => onChange(v)}>
          {t}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, title, sub, disabled }: { checked: boolean; onChange(v: boolean): void; title: string; sub: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className="switch" role="switch" aria-checked={checked} aria-disabled={disabled || undefined} onClick={() => !disabled && onChange(!checked)}>
      <span>
        <b>{title}</b>
        <span className="small">{sub}</span>
      </span>
      <span className="tog" />
    </button>
  );
}

/** Funded -> Waiting -> Delivered, in the only three words the product uses. `stage`: 0 funded, 1 waiting, 3 delivered. */
export function StatusTrack({ stage }: { stage: 0 | 1 | 2 | 3 }) {
  const names = ['Funded', 'Waiting', 'Delivered'];
  return (
    <div className="status" aria-label={`Status: ${names[Math.min(stage, 2)]}`}>
      {names.map((n, i) => {
        const cls = i < stage ? 'done' : i === stage ? 'now' : '';
        return (
          <span key={n} style={{ display: 'contents' }}>
            {i > 0 && <span className={`bar ${i <= stage ? 'done' : ''}`} />}
            <div className={`s ${cls}`}>
              <i />
              {n}
            </div>
          </span>
        );
      })}
    </div>
  );
}

/** A sealed envelope that opens to show its letter. `open` toggles the animation. */
export function Envelope({ open, children, label }: { open: boolean; children: ReactNode; label: string }) {
  return (
    <div className={`stage${open ? ' open' : ''}`} role="img" aria-label={label}>
      <div className="env">
        <div className="back" />
        <div className="letter">{children}</div>
        <div className="front" />
        <div className="flap" />
        <div className="seal">K</div>
      </div>
    </div>
  );
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${70 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function CopyBox({ value, label, onCopied }: { value: string; label: string; onCopied(): void }) {
  return (
    <div className="copybox">
      <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="mini"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            onCopied();
          } catch { /* user can still select the text */ }
        }}
      >
        Copy
      </button>
    </div>
  );
}
