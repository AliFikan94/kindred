import { useId, useMemo } from 'react';
import { fmtDate } from '../lib/dates.js';
import { worthAt, Slice } from '../lib/projection.js';

const W = 640, H = 200, PX = 8, PT = 14, PB = 24;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * The thread: value over time from today to the last payment. Drag (or use the arrow keys on the
 * hidden slider) to travel through time. It is an illustration with a fixed assumption, never a forecast.
 */
export function Thread({ slices, t0, grow, unit, scrub, onScrub, preset, hint }: {
  slices: Slice[];
  t0: number;
  grow: boolean;
  unit: string;
  scrub: number;
  onScrub(v: number): void;
  preset: 'family' | 'pay' | 'drop';
  hint: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const m = useMemo(() => {
    if (slices.length === 0) return null;
    const end = Math.max(...slices.map((s) => s.t));
    const span = Math.max(end - t0, 86_400);
    const endWorth = worthAt(end, slices, t0, grow);
    const maxV = Math.max(endWorth.total, 1e-9) * 1.06;
    const minV = grow ? endWorth.principal * 0.82 : 0;
    const X = (t: number) => PX + ((t - t0) / span) * (W - 2 * PX);
    const Y = (v: number) => H - PB - ((v - minV) / (maxV - minV)) * (H - PB - PT);
    const N = 120;
    let d = '';
    for (let i = 0; i <= N; i++) {
      const t = t0 + (span * i) / N;
      d += `${i ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(worthAt(t, slices, t0, grow).total).toFixed(1)}`;
    }
    return { end, span, endWorth, X, Y, d, area: `${d}L${X(end)} ${H - PB}L${X(t0)} ${H - PB}Z` };
  }, [slices, t0, grow]);

  if (!m) return null;
  const sx = PX + (scrub / 1000) * (W - 2 * PX);
  const st = t0 + (scrub / 1000) * m.span;
  const w = worthAt(st, slices, t0, grow);
  const atEnd = scrub >= 1000, atStart = scrub <= 0;
  const when = atStart ? 'Today' : atEnd ? fmtDate(m.end) : fmtDate(Math.round(st));
  const grown = w.total - Math.min(w.principal, w.total);
  const dots = [...new Set(slices.map((s) => s.t))];

  let sub: JSX.Element | string = '';
  if (preset !== 'family') {
    sub = (
      <>
        Arrived <b>{fmt(w.arrived)}</b> · waiting <b>{fmt(w.waiting)}</b>
        {grow && <> · <em>+{fmt(grown)} {unit} grown</em></>}
      </>
    );
  } else if (grow) {
    sub = <em>+{fmt(grown)} {unit} grown</em>;
  } else {
    sub = atEnd ? 'Arrives on the day.' : 'Waiting, safely.';
  }

  return (
    <div className="chart">
      <div className="readout" aria-live="polite">
        <div className="when">{when}</div>
        <div className="big">{fmt(w.total)} <small>{unit}</small></div>
        <div className="sub">{sub}</div>
      </div>
      <div style={{ position: 'relative' }}>
        <svg className="tl" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Value over time">
          <defs>
            <linearGradient id={`dg${uid}`} x1="0" x2="1"><stop offset="0" stopColor="var(--dawn-a)" /><stop offset="1" stopColor="var(--dawn-b)" /></linearGradient>
            <linearGradient id={`fd${uid}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--dawn-b)" stopOpacity=".28" /><stop offset="1" stopColor="var(--dawn-a)" stopOpacity="0" /></linearGradient>
            <clipPath id={`pt${uid}`}><rect x="0" y="0" width={sx.toFixed(1)} height={H} /></clipPath>
          </defs>
          {grow && <line x1={PX} x2={W - PX} y1={m.Y(m.endWorth.principal)} y2={m.Y(m.endWorth.principal)} stroke="var(--line)" strokeDasharray="3 5" />}
          <line x1={PX} x2={W - PX} y1={H - PB} y2={H - PB} stroke="var(--line)" />
          <path d={m.d} fill="none" stroke="var(--line)" strokeWidth="3" strokeLinecap="round" />
          <g clipPath={`url(#pt${uid})`}>
            <path d={m.area} fill={`url(#fd${uid})`} />
            <path d={m.d} fill="none" stroke={`url(#dg${uid})`} strokeWidth="4" strokeLinecap="round" />
          </g>
          {dots.map((t) => (
            <circle key={t} cx={m.X(t)} cy={m.Y(worthAt(t, slices, t0, grow).total)} r={t <= st ? 5.5 : 4} fill={t <= st ? 'var(--ink)' : 'var(--paper)'} stroke="var(--ink)" strokeWidth="1.5" />
          ))}
          <line x1={sx} x2={sx} y1={PT} y2={H - PB} stroke="var(--ink)" strokeWidth="1" opacity=".35" />
          <circle cx={sx} cy={m.Y(w.total)} r="9" fill="var(--paper)" stroke={`url(#dg${uid})`} strokeWidth="4" />
        </svg>
        <input
          className="scrub"
          type="range"
          min={0}
          max={1000}
          value={scrub}
          aria-label="Travel through time"
          aria-valuetext={`${when}: ${fmt(w.total)} ${unit}`}
          onChange={(e) => onScrub(+e.target.value)}
          style={{ top: 0, bottom: 0, height: '100%' }}
        />
        {hint && <span className="hint">drag to travel through time</span>}
      </div>
      <div className="axis"><span>Today</span><span>{fmtDate(m.end)}</span></div>
    </div>
  );
}
