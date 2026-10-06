import { useEffect, useMemo, useState } from 'react';
import { privateKeyToAccount } from 'viem/accounts';
import { State, Status, Stage, ScheduleView, TrancheView, isOpen } from '../chain/types.js';
import { CopyBox, Envelope, Loading, StatusTrack, Switch } from '../components/ui.js';
import { useApp } from '../context.js';
import { useAction, useChainClock, useSchedule } from '../hooks.js';
import { fmtDate, humanSpan, localTimeOfUnlock, ordinal, spanBetween } from '../lib/dates.js';
import { Address, fmtMon, parseAddress, shortAddr } from '../lib/format.js';
import { buildIcs } from '../lib/ics.js';
import { Meta, scheduleLink } from '../lib/share.js';
import { loadMeta } from '../lib/store.js';
import { navigate } from '../router.js';

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const CANCEL_DELAY = 7 * 86_400;

function Dots({ n }: { n: number }) {
  return (
    <div className="thread" aria-hidden="true" style={{ padding: '0 0 22px' }}>
      {[1, 2, 3, 4].map((i) => <span key={i} className={i <= n ? 'on' : ''} />)}
    </div>
  );
}

export function Schedule({ vault, urlMeta, fresh }: { vault: Address; urlMeta: Meta | null; fresh: boolean }) {
  const { data: s, error, refresh, fetchedAt } = useSchedule(vault);
  const meta = useMemo(() => urlMeta ?? loadMeta(vault), [urlMeta, vault]);
  const now = useChainClock(s?.chainNow, fetchedAt.current);

  useEffect(() => {
    document.title = `${meta?.label ? meta.label + ' · ' : ''}Kindred`;
    return () => { document.title = 'Kindred'; };
  }, [meta?.label]);

  if (error && !s) {
    return (
      <section className="center">
        <h1>We can’t open this one.</h1>
        <p className="lede">{error}</p>
        <p style={{ marginTop: 24 }}><a className="link" href="#/">Make a new schedule</a></p>
      </section>
    );
  }
  if (!s) return <section><Loading /></section>;
  return <View s={s} meta={meta} now={now} fresh={fresh} refresh={refresh} />;
}

function View({ s, meta, now, fresh, refresh }: { s: ScheduleView; meta: Meta | null; now: number; fresh: boolean; refresh(): Promise<void> }) {
  const { cfg, adapter, account, connect, toast } = useApp();
  const act = useAction();
  const [lookAs, setLookAs] = useState<'auto' | 'recipient'>('auto');

  const keyAddr = meta?.key ? (privateKeyToAccount(meta.key).address as Address) : null;
  const isCreator = eq(account, s.creator) && lookAs === 'auto';
  const mine = s.tranches.filter((t) => (account && eq(t.recipient, account) && lookAs === 'auto') || (keyAddr && eq(t.recipient, keyAddr)));
  const isRecipient = mine.length > 0 && !isCreator;
  const canToggle = !!keyAddr && eq(account, s.creator);

  const preset = meta?.preset ?? (s.tranches.length > 1 ? 'drop' : 'family');
  const label = meta?.label ?? (s.tranches.length === 1 ? shortAddr(s.tranches[0]!.recipient) : `${s.tranches.length} people`);
  const total = s.tranches.reduce((a, t) => a + t.amount, 0n);
  const open = s.tranches.filter((t) => isOpen(t.status));
  const delivered = s.tranches.filter((t) => t.status === Status.Delivered);
  const cancelled = s.tranches.filter((t) => t.status === Status.Cancelled);
  const next = open.length ? Math.min(...open.map((t) => t.unlockTime)) : null;
  const last = Math.max(...s.tranches.map((t) => t.unlockTime));
  const allDelivered = delivered.length === s.tranches.length;
  const dueNow = open.filter((t) => now >= t.unlockTime);
  const single = s.tranches.length === 1;
  const t0 = s.tranches[0]!;
  const proof = (t: TrancheView) => s.deliveries.find((d) => d.id === t.id);
  const shownAmount = (t: TrancheView) => (t.status === Status.Delivered && t.payout > 0n ? t.payout : t.amount);

  // The envelope opens when everything has arrived (single) or whatever is in it has arrived.
  const opened = allDelivered;
  const stage: 0 | 1 | 3 = allDelivered ? 3 : 1;

  const link = scheduleLink(location.origin + location.pathname.replace(/index\.html$/, ''), s.address, meta ?? undefined);
  const explorer = (tx: string) => (cfg.explorer ? `${cfg.explorer.replace(/\/$/, '')}/tx/${tx}` : null);

  // ---------------------------------------------------------------- headline
  let kicker = '';
  let title = '';
  let lede: string | null = null;
  if (cancelled.length === s.tranches.length) {
    title = 'This one was cancelled.';
    lede = 'Nothing is waiting here any more.';
  } else if (isRecipient || (!isCreator && !fresh)) {
    kicker = `A gift from ${meta?.from ?? 'someone who cares about you'}`;
    if (allDelivered) {
      title = preset === 'family' && meta?.moment?.endsWith('birthday') ? `Happy ${meta.moment}, ${label}.` : 'It’s yours.';
      kicker = proof(t0)?.how === 'claimed' ? 'You collected it.' : 'It arrived on its own.';
    } else title = 'Something is waiting for you.';
  } else if (fresh && !allDelivered) {
    title = `Sealed for ${label}.`;
    lede = single ? `It opens on ${fmtDate(t0.unlockTime)}.` : `First payment ${fmtDate(Math.min(...s.tranches.map((t) => t.unlockTime)))}.`;
  } else {
    title = label;
    lede = allDelivered ? 'Everything has arrived.' : next !== null ? `Next: ${fmtDate(next)}.` : null;
  }

  const countdown = !allDelivered && next !== null ? (now >= next ? 'Opening now…' : `Opens in ${humanSpan(spanBetween(now, next))}`) : '';

  // ---------------------------------------------------------------- calendar
  function downloadIcs() {
    const text = buildIcs(
      s.tranches.map((t) => ({
        uid: `${s.address}-${t.id}@kindred`,
        day: t.unlockTime,
        summary: `Kindred: ${fmtMon(t.amount)} ${cfg.currency} arrives for ${label}`,
        description: 'Sent automatically. Nothing to do.',
      })),
    );
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kindred.ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------- letter
  const letter = (
    <>
      <div className="to">For {label}</div>
      <div className="amt">{fmtMon(single ? shownAmount(t0) : total, 2)} <small>{cfg.currency}</small></div>
      {single && meta?.note && <div className="words">“{meta.note}”</div>}
      {!single && (
        <div className="pays">
          {s.tranches.slice(0, 4).map((t) => (
            <div key={t.id}>{t.status === Status.Delivered ? '✓ ' : ''}{fmtDate(t.unlockTime)} · {fmtMon(t.amount)}</div>
          ))}
          {s.tranches.length > 4 && <div>+ {s.tranches.length - 4} more</div>}
        </div>
      )}
      {single && delivered[0] && proof(t0) && (
        <div className="arrived">{proof(t0)!.how === 'claimed' ? 'Collected' : 'Arrived'} {fmtDate(proof(t0)!.blockTime)}, {afterMidnight(proof(t0)!.blockTime - t0.unlockTime)}.</div>
      )}
    </>
  );

  // ---------------------------------------------------------------- cancel
  const canCancel = isCreator && s.revocable && s.state === State.Active && open.some((t) => now < t.unlockTime);
  const cancelReadyAt = s.cancelRequestedAt ? s.cancelRequestedAt + CANCEL_DELAY : 0;

  const doAct = (name: string, fn: () => Promise<unknown>, done?: string) =>
    act.run(name, async () => {
      await fn();
      await refresh();
      if (done) toast(done);
    });

  return (
    <section className="center" aria-live="polite">
      <Dots n={4} />
      {kicker && <p className="small" id="kicker">{kicker}</p>}
      <h1 tabIndex={-1}>{title}</h1>
      {lede && <p className="lede">{lede}</p>}

      {canToggle && (
        <p style={{ marginTop: 14 }}>
          <button className="mini" aria-pressed={lookAs === 'auto'} onClick={() => setLookAs('auto')}>Creator view</button>{' '}
          <button className="mini" aria-pressed={lookAs === 'recipient'} onClick={() => setLookAs('recipient')}>See {label}’s side</button>
        </p>
      )}

      {cancelled.length < s.tranches.length && <Envelope open={opened} label={opened ? 'An open envelope' : 'A sealed envelope'}>{letter}</Envelope>}
      {countdown && <p className="countdown" role="timer">{countdown}</p>}
      {cancelled.length < s.tranches.length && <StatusTrack stage={stage} />}
      {!single && !allDelivered && <p className="small" style={{ marginTop: 14 }}>{delivered.length} of {s.tranches.length} delivered</p>}

      {/* things the recipient can do */}
      {(isRecipient || dueNow.some((t) => account && eq(t.recipient, account))) && (
        <RecipientActions s={s} mine={mine} keyHex={meta?.key} keyAddr={keyAddr} act={act} doAct={doAct} now={now} />
      )}
      {!isRecipient && !isCreator && dueNow.length > 0 && !account && cfg.mode === 'live' && (
        <div className="panel"><p>If this is for you, connect the wallet it was sent to.</p><div className="row"><button className="cta line" onClick={connect}>Connect wallet</button></div></div>
      )}

      {/* delivery proof */}
      {delivered.length > 0 && (
        <p className="proof" style={{ color: 'var(--muted)' }}>
          {delivered.slice(0, 1).map((t) => {
            const p = proof(t);
            if (!p) return null;
            const url = explorer(p.tx);
            return <span key={t.id}>{p.how === 'claimed' ? 'Collected' : 'Delivered'} {afterMidnight(p.blockTime - t.unlockTime)} · {url ? <a href={url} target="_blank" rel="noreferrer noopener">view transaction</a> : <code>{p.tx.slice(0, 10)}…</code>}</span>;
          })}
        </p>
      )}

      {/* facts */}
      <dl className="summary" style={{ textAlign: 'left' }}>
        <Row k={single ? 'Arrives' : 'Payments'} v={single ? `${fmtDate(last)} · ${localTimeOfUnlock(last)} your time` : `${s.tranches.length}, ${fmtDate(Math.min(...s.tranches.map((t) => t.unlockTime)))} to ${fmtDate(last)}`} />
        <Row k="Amount" v={`${fmtMon(total)} ${cfg.currency}${single ? '' : ' in total'}`} />
        <Row k="While it waits" v={waiting(s, cfg.currency)} />
        <Row k="Changes" v={!s.revocable ? 'Permanent. It can’t be cancelled.' : s.cancelRequestedAt ? `Cancelling on ${fmtDate(cancelReadyAt)}` : 'The creator can cancel, with 7 days’ notice.'} />
        <Row k="Schedule" v={<code title={s.address}>{shortAddr(s.address)}</code>} />
      </dl>

      {/* creator tools */}
      {isCreator && (
        <div className="stack" style={{ marginTop: 26 }}>
          {meta?.key && (
            <div className="panel" style={{ marginTop: 0 }}>
              <h2>Send {label} this link</h2>
              <p>It’s how {label} collects the gift, and they don’t need a wallet to open it. Anyone with the link can collect, so send it privately.</p>
              <CopyBox value={link} label={`Gift link for ${label}`} onCopied={() => toast('Link copied')} />
            </div>
          )}
          {!meta?.key && (
            <div className="panel" style={{ marginTop: 0 }}>
              <h2>Share this page</h2>
              <p>It shows {label} the countdown and, on the day, the gift.</p>
              <CopyBox value={link} label="Link to this schedule" onCopied={() => toast('Link copied')} />
            </div>
          )}
          <div className="pair" style={{ marginTop: 14 }}>
            <button className="cta line" onClick={downloadIcs}>Add to my calendar</button>
          </div>
        </div>
      )}
      {isRecipient && !allDelivered && (
        <div className="pair"><button className="cta line" onClick={downloadIcs}>Add to my calendar</button></div>
      )}

      {canCancel && (
        <div className="panel">
          <h2>Change your mind?</h2>
          {!s.cancelRequestedAt ? (
            <>
              <p>Cancelling takes 7 days, and {preset === 'family' ? label : 'the recipients'} can see it coming. Anything that unlocks during the wait is still delivered.</p>
              <div className="row"><button className="cta line" disabled={!!act.busy} onClick={() => doAct('cancel', () => adapter.requestCancel(s.address), 'Cancellation started')}>{act.busy === 'cancel' ? 'Working…' : 'Start cancelling'}</button></div>
            </>
          ) : (
            <>
              <p>Cancelling on {fmtDate(cancelReadyAt)}. {now < cancelReadyAt ? `${humanSpan(spanBetween(now, cancelReadyAt))} to go.` : 'The wait is over.'}</p>
              <div className="row">
                <button className="cta line" disabled={!!act.busy || now < cancelReadyAt} onClick={() => doAct('finalize', () => adapter.finalizeCancel(s.address), 'Cancelled. What was left is back with you.')}>{act.busy === 'finalize' ? 'Working…' : 'Finish cancelling'}</button>
                <button className="cta line" disabled={!!act.busy} onClick={() => doAct('abort', () => adapter.abortCancel(s.address), 'Cancellation stopped')}>Keep it</button>
              </div>
            </>
          )}
        </div>
      )}
      {act.error && <p className="err" role="alert">{act.error}</p>}

      {cfg.mode === 'sim' && <DemoControls s={s} next={next} refresh={refresh} />}
      {cfg.keeperUrl && <KeeperBadge url={cfg.keeperUrl} />}
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><dt>{k}</dt><dd>{v}</dd></div>;
}

function afterMidnight(sec: number): string {
  if (sec <= 0) return 'right on time';
  if (sec < 120) return `${sec} second${sec === 1 ? '' : 's'} after midnight UTC`;
  if (sec < 7200) return `${Math.round(sec / 60)} minutes after midnight UTC`;
  return `${Math.round(sec / 3600)} hours after midnight UTC`;
}

function waiting(s: ScheduleView, cur: string): string {
  if (!s.staked) return 'Held safely, untouched';
  const unbonding = s.tranches.some((t) => t.stage === Stage.Unbonding && t.status === Status.Pending);
  if (unbonding) return 'Coming back from staking, ready on the day';
  if (s.position && s.position.stake > 0n) {
    if (s.position.rewards === 0n) return `Growing on Monad: ${fmtMon(s.position.stake)} ${cur} staked`;
    return `Growing on Monad: ${fmtMon(s.position.stake)} → ${fmtMon(s.position.stake + s.position.rewards)} ${cur} so far`;
  }
  if (s.position && s.tranches.some((t) => t.stage === Stage.Staked)) return 'Staked on Monad, starting to earn';
  return 'Staked on Monad';
}

// ------------------------------------------------------------------ recipient

function RecipientActions({ s, mine, keyHex, keyAddr, act, doAct, now }: {
  s: ScheduleView; mine: TrancheView[]; keyHex?: `0x${string}`; keyAddr: Address | null;
  act: ReturnType<typeof useAction>; doAct: (n: string, f: () => Promise<unknown>, d?: string) => Promise<boolean>; now: number;
}) {
  const { adapter, cfg, account, connect } = useApp();
  const [held, setHeld] = useState<bigint>(0n);
  const [dest, setDest] = useState('');
  const usingKey = (t: TrancheView) => (keyHex && keyAddr && eq(t.recipient, keyAddr) && !(account && eq(t.recipient, account)) ? keyHex : undefined);
  const collectable = mine.filter((t) => isOpen(t.status) && now >= t.unlockTime);
  const hasKeyFunds = !!keyAddr && mine.some((t) => eq(t.recipient, keyAddr));

  useEffect(() => {
    if (!keyAddr) return;
    let alive = true;
    const load = () => adapter.balance(keyAddr).then((b) => alive && setHeld(b)).catch(() => {});
    void load();
    const t = window.setInterval(load, 4000);
    return () => { alive = false; window.clearInterval(t); };
  }, [adapter, keyAddr, s.deliveries.length]);

  const target = parseAddress(dest) ?? account;
  const delivered = mine.some((t) => t.status === Status.Delivered);

  return (
    <>
      {collectable.length > 0 && (
        <div className="panel">
          <h2>It’s time.</h2>
          <p>It is usually delivered for you within moments. If it hasn’t arrived, you can collect it yourself{keyAddr ? ' (the link carries a little gas for this)' : ''}.</p>
          <div className="row">
            {collectable.map((t) => (
              <button key={t.id} className="cta dawn" disabled={!!act.busy} onClick={() => doAct(`claim${t.id}`, () => adapter.claim(s.address, t.id, usingKey(t)), 'Collected')}>
                {act.busy === `claim${t.id}` ? 'Collecting…' : mine.length > 1 ? `Collect ${fmtDate(t.unlockTime)}` : 'Collect it'}
              </button>
            ))}
          </div>
        </div>
      )}
      {hasKeyFunds && delivered && held > 0n && (
        <div className="panel">
          <h2>Move it to your wallet</h2>
          <p>{fmtMon(held)} {cfg.currency} is waiting at this link’s address. Send it to a wallet you control.</p>
          {!account && cfg.mode === 'live' ? (
            <div className="row"><button className="cta line" onClick={connect}>Connect wallet</button></div>
          ) : null}
          <label className="lbl" htmlFor="dest">Send to</label>
          <input id="dest" className="field" style={{ fontSize: 16 }} spellCheck={false} placeholder={account ? `${shortAddr(account)} (this wallet)` : '0x…'} value={dest} onChange={(e) => setDest(e.target.value)} />
          <div className="row">
            <button className="cta dawn" disabled={!!act.busy || !target || !keyHex} onClick={() => keyHex && target && doAct('move', () => adapter.moveAll(keyHex, target), 'Moved to your wallet')}>
              {act.busy === 'move' ? 'Moving…' : 'Move it'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ demo + keeper

function DemoControls({ s, next, refresh }: { s: ScheduleView; next: number | null; refresh(): Promise<void> }) {
  const { sim, adapter } = useApp();
  const [on, setOn] = useState(sim?.isKeeperOn() ?? true);
  if (!sim) return null;
  return (
    <div className="panel" style={{ borderStyle: 'dashed' }}>
      <h2>Demo controls</h2>
      <p>Everything here happens in your browser. In real life none of this is needed: it just happens.</p>
      <div className="row">
        <button className="cta dawn" disabled={next === null} onClick={async () => { if (next !== null) { await adapter.travelTo?.(next); await refresh(); } }}>
          Jump to the day ›
        </button>
        <button className="cta line" onClick={async () => { await adapter.travelTo?.(s.chainNow + 30 * 86_400); await refresh(); }}>+30 days</button>
      </div>
      <Switch checked={on} onChange={(v) => { sim.setKeeper(v); setOn(v); void refresh(); }} title="Delivery keeper" sub={on ? 'On: delivers on the day, for you.' : 'Off: nothing is delivered for you. The recipient can still collect it themselves.'} />
      <div className="row"><button className="link" onClick={() => { try { localStorage.removeItem('kindred-sim-v1'); } catch { /* ignore */ } location.hash = '#/'; location.reload(); }}>Reset the demo</button></div>
    </div>
  );
}

function KeeperBadge({ url }: { url: string }) {
  const [r, setR] = useState<{ deliveries: number; onTimeRate: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url.replace(/\/$/, '') + '/status').then((x) => x.json()).then((j) => alive && setR(j.reliability)).catch(() => {});
    return () => { alive = false; };
  }, [url]);
  if (!r || r.deliveries === 0) return null;
  return <p className="small" style={{ marginTop: 22 }}>The delivery keeper has delivered {r.deliveries} on time {r.onTimeRate === null ? '' : `(${Math.round(r.onTimeRate * 100)}% within a minute)`}.</p>;
}

void ordinal;
