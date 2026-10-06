import { useEffect, useState } from 'react';
import { ScheduleView, State, Status } from '../chain/types.js';
import { Loading } from '../components/ui.js';
import { useApp } from '../context.js';
import { fmtDate } from '../lib/dates.js';
import { friendlyError } from '../lib/errors.js';
import { Address, fmtMon, shortAddr } from '../lib/format.js';
import { encodeMeta } from '../lib/share.js';
import { loadMeta } from '../lib/store.js';
import { hrefSchedule } from '../router.js';

export function Mine() {
  const { adapter, account, connect, cfg } = useApp();
  const [items, setItems] = useState<ScheduleView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    let alive = true;
    (async () => {
      try {
        const vaults: Address[] = await adapter.listByCreator(account);
        const views = await Promise.all(vaults.slice(0, 30).map((v) => adapter.get(v).catch(() => null)));
        if (alive) setItems(views.filter((v): v is ScheduleView => v !== null));
      } catch (e) {
        if (alive) setErr(friendlyError(e));
      }
    })();
    return () => { alive = false; };
  }, [adapter, account]);

  if (!account) {
    return (
      <section className="center">
        <h1>Your schedules.</h1>
        <p className="lede">Connect your wallet to see what you’ve set up.</p>
        <button className="cta" onClick={connect}>Connect wallet</button>
      </section>
    );
  }
  if (err) return <section><h1>Something is off.</h1><p className="lede">{err}</p></section>;
  if (!items) return <section><Loading /></section>;

  return (
    <section>
      <h1>Your schedules.</h1>
      {items.length === 0 ? (
        <>
          <p className="lede">Nothing yet. Set one up and it will appear here.</p>
          <p style={{ marginTop: 22 }}><a className="cta" style={{ display: 'grid', placeItems: 'center', textDecoration: 'none' }} href="#/">Send something to the future</a></p>
        </>
      ) : (
        <ul className="list">
          {items.map((s) => {
            const meta = loadMeta(s.address);
            const total = s.tranches.reduce((a, t) => a + t.amount, 0n);
            const done = s.tranches.filter((t) => t.status === Status.Delivered).length;
            const cancelled = s.tranches.every((t) => t.status === Status.Cancelled);
            const next = Math.min(...s.tranches.filter((t) => t.status === Status.Pending || t.status === Status.Claimable).map((t) => t.unlockTime));
            const state = cancelled ? 'Cancelled' : s.state === State.Closed ? 'Delivered' : Number.isFinite(next) ? `Next ${fmtDate(next)}` : 'Waiting';
            return (
              <li key={s.address}>
                <a href={hrefSchedule(s.address, meta ? encodeMeta(meta) : undefined)}>
                  <b style={{ fontWeight: 500 }}>{meta?.label ?? shortAddr(s.address)}</b>
                  <div className="sub">{fmtMon(total)} {cfg.currency}{s.tranches.length > 1 ? ` · ${done} of ${s.tranches.length} delivered` : ''}{s.staked ? ' · growing' : ''}</div>
                </a>
                <span className="sub">{state}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
