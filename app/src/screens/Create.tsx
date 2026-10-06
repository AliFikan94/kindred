import { useEffect, useMemo, useRef, useState } from 'react';
import { generatePrivateKey } from 'viem/accounts';
import { Chips, Loading, Switch } from '../components/ui.js';
import { Thread } from '../components/Thread.js';
import { useApp } from '../context.js';
import { DAY, fmtDate, localTimeOfUnlock } from '../lib/dates.js';
import { friendlyError } from '../lib/errors.js';
import { defaultForm, derive, FieldKey, Form, giftAddress, Moment } from '../lib/form.js';
import { fmtMon } from '../lib/format.js';
import { Limits, principal, requiredValue, reserve, lastUnlock } from '../lib/plan.js';
import { encodeMeta, Meta, PresetKey } from '../lib/share.js';
import { saveMeta } from '../lib/store.js';
import { navigate } from '../router.js';

const GAS_DRIP = 2n * 10n ** 16n; // 0.02 MON so a gift link can claim without any keeper
const WHO_KEYS: FieldKey[] = ['name', 'dob', 'custom', 'wallet', 'start', 'addresses', 'dropDate'];

const COPY: Record<PresetKey, { h: string; lede: string }> = {
  family: { h: 'Who is this for?', lede: 'Pick a moment. We’ll make sure it arrives.' },
  pay: { h: 'Who are you paying?', lede: 'Set it once. They’re paid on the same day every month.' },
  drop: { h: 'Who’s getting it?', lede: 'One day, everyone, no gas to chase.' },
};
const ALSO: Record<PresetKey, string> = { family: 'A family gift', pay: 'Paying someone monthly', drop: 'A community drop' };

export function Create() {
  const { adapter } = useApp();
  const [limits, setLimits] = useState<Limits | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    adapter.limits().then(setLimits).catch((e) => setErr(friendlyError(e)));
  }, [adapter]);
  if (err) return <section><h1>Something is off.</h1><p className="lede">{err}</p></section>;
  if (!limits) return <section><Loading /></section>;
  return <Flow limits={limits} />;
}

function Field({ label, id, error, children }: { label: string; id: string; error?: string; children: React.ReactNode }) {
  return (
    <>
      <label className="lbl" htmlFor={id}>{label}</label>
      {children}
      <p className="err" role="alert" id={`${id}-err`}>{error ?? ''}</p>
    </>
  );
}

function Flow({ limits }: { limits: Limits }) {
  const { cfg, adapter, account, toast } = useApp();
  const giftKey = useMemo(() => generatePrivateKey(), []);
  const [form, setForm] = useState<Form>(() => defaultForm(limits.now));
  const [step, setStep] = useState<'who' | 'grow' | 'seal'>('who');
  const [show, setShow] = useState(false);
  const [scrub, setScrub] = useState(1000);
  const [scrubbed, setScrubbed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const h1 = useRef<HTMLHeadingElement>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const d = useMemo(() => derive(form, { limits, tip: cfg.tip, giftKey }), [form, limits, cfg.tip, giftKey]);
  const p = d.plan;
  const whoErrors = WHO_KEYS.filter((k) => d.errors[k]);
  const e = (k: FieldKey) => (show ? d.errors[k] : undefined);

  useEffect(() => { h1.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }, [step]);

  const go = (s: typeof step) => { setStep(s); setShow(false); setError(null); };
  const dots = step === 'who' ? 1 : step === 'grow' ? 2 : 3;

  async function lock() {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      if (!account) await adapter.connect();
      const { vault } = await adapter.create(p);
      const meta: Meta = { v: 1, preset: p.preset, label: p.label, moment: p.moment, note: p.note, from: p.from, key: p.key };
      saveMeta(vault, meta);
      if (p.key) {
        try {
          await adapter.fundGas(giftAddress(p.key), GAS_DRIP);
        } catch {
          toast('Created. The gift link could not be topped up with gas, but the gift will still be delivered automatically.');
        }
      }
      navigate(`#/s/${vault}?m=${encodeMeta(meta)}&new=1`);
    } catch (x) {
      setError(friendlyError(x));
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ step 1
  if (step === 'who') {
    return (
      <section>
        <Dots n={dots} />
        <h1 ref={h1} tabIndex={-1}>{COPY[form.preset].h}</h1>
        <p className="lede">{COPY[form.preset].lede}</p>

        <Field label={form.preset === 'drop' ? 'Community name' : 'Their first name'} id="name" error={e('name')}>
          <input id="name" className="field" value={form.name} maxLength={40} autoComplete="off" placeholder={form.preset === 'family' ? 'Maya' : form.preset === 'pay' ? 'Sam' : 'Design Guild'}
            aria-invalid={!!e('name')} aria-describedby="name-err" onChange={(ev) => set('name', ev.target.value)} />
        </Field>

        {form.preset === 'family' && (
          <>
            <Field label="Date of birth" id="dob" error={e('dob')}>
              <input id="dob" className="field" type="date" value={form.dob} aria-invalid={!!e('dob')} onChange={(ev) => set('dob', ev.target.value)} />
            </Field>
            <span className="lbl">Send it on their</span>
            <Chips<Moment> label="Moment" value={form.moment} onChange={(v) => set('moment', v)}
              items={[['18', '18th birthday'], ['21', '21st birthday'], ['custom', 'Another day'], ...(cfg.demo ? ([['soon', 'In a few minutes']] as Array<[Moment, string]>) : [])]} />
            {form.moment === 'custom' && (
              <Field label="Date" id="custom" error={e('custom')}>
                <input id="custom" className="field" type="date" value={form.custom} onChange={(ev) => set('custom', ev.target.value)} />
              </Field>
            )}
            {form.moment === 'soon' && (
              <div style={{ marginTop: 14 }}>
                <Chips<number> label="Minutes" value={form.soonMinutes} onChange={(v) => set('soonMinutes', v)} items={[[2, '2 min'], [5, '5 min'], [10, '10 min']]} />
              </div>
            )}
            <span className="lbl">Their wallet</span>
            <Chips<'link' | 'wallet'> label="Wallet" value={form.recipientMode} onChange={(v) => set('recipientMode', v)} items={[['link', 'They don’t have one yet'], ['wallet', 'I have their address']]} />
            {form.recipientMode === 'link' ? (
              <p className="helper">You’ll get a private link to send them. They don’t need a wallet to open it. Anyone with the link can collect the gift, so share it only with them.</p>
            ) : (
              <Field label="Wallet address" id="wallet" error={e('wallet')}>
                <input id="wallet" className="field" style={{ fontSize: 18 }} value={form.wallet} spellCheck={false} placeholder="0x…" onChange={(ev) => set('wallet', ev.target.value)} />
              </Field>
            )}
          </>
        )}

        {form.preset === 'pay' && (
          <>
            <Field label="Their wallet address" id="wallet" error={e('wallet')}>
              <input id="wallet" className="field" style={{ fontSize: 18 }} value={form.wallet} spellCheck={false} placeholder="0x…" onChange={(ev) => set('wallet', ev.target.value)} />
            </Field>
            <Field label="First payment" id="start" error={e('start')}>
              <input id="start" className="field" type="date" value={form.start} onChange={(ev) => set('start', ev.target.value)} />
            </Field>
            <span className="lbl">Every month for</span>
            <Chips<number> label="Months" value={form.months} onChange={(v) => set('months', v)} items={[[3, '3 months'], [6, '6 months'], [12, '12 months']]} />
          </>
        )}

        {form.preset === 'drop' && (
          <>
            <Field label="Wallet addresses (one per line)" id="addresses" error={e('addresses')}>
              <textarea id="addresses" className="field" value={form.addresses} spellCheck={false} placeholder={'0x…\n0x…'} onChange={(ev) => set('addresses', ev.target.value)} />
            </Field>
            <Field label="Day it arrives" id="dropDate" error={e('dropDate')}>
              <input id="dropDate" className="field" type="date" value={form.dropDate} onChange={(ev) => set('dropDate', ev.target.value)} />
            </Field>
          </>
        )}

        <button className="cta" onClick={() => (whoErrors.length ? setShow(true) : go('grow'))}>Continue</button>
        <p className="also">
          Also for:{' '}
          {(['family', 'pay', 'drop'] as PresetKey[]).filter((k) => k !== form.preset).map((k, i) => (
            <span key={k}>{i > 0 && ' · '}<button className="link" onClick={() => { setForm(defaultForm(limits.now, k)); setShow(false); }}>{ALSO[k]}</button></span>
          ))}
        </p>
      </section>
    );
  }

  // ------------------------------------------------------------------ step 2
  if (step === 'grow') {
    const slices = p ? p.tranches.map((t) => ({ t: t.unlockTime, amount: Number(t.amount) / 1e18 })) : [];
    const lead = limits.stakeLead === null ? null : Math.ceil(limits.stakeLead / DAY);
    const growSub = limits.stakeLead === null
      ? 'Not available on this network.'
      : !d.growEligible
        ? `Needs the date to be at least ${lead} days away.`
        : 'Staked on Monad until the day. Optional. It makes the schedule permanent: it can’t be cancelled.';
    const per = form.preset === 'pay' ? 'Paid each month.' : form.preset === 'drop' ? 'Each person gets this.' : '';
    return (
      <section>
        <Dots n={dots} />
        <h1 ref={h1} tabIndex={-1}>How much?</h1>
        <div className="amount-wrap">
          <input id="amount" inputMode="decimal" autoComplete="off" placeholder="0" aria-label={`Amount in ${cfg.currency}`} value={form.amount}
            style={{ width: `${Math.max(2, form.amount.length + 0.3)}ch` }}
            onChange={(ev) => set('amount', ev.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 12))} />
          <span className="unit">{cfg.currency}</span>
        </div>
        <p className="small" style={{ marginTop: 10 }}>{per} {p ? `${form.preset === 'family' ? `For ${p.label}, on ${fmtDate(p.tranches[0]!.unlockTime)}.` : ''}` : ''}</p>
        <p className="err" role="alert">{show ? d.errors.amount ?? d.issues[0] ?? '' : ''}</p>

        <Switch checked={form.grow && d.growEligible} disabled={!d.growEligible} onChange={(v) => set('grow', v)} title="Let it grow while it waits" sub={growSub} />

        {p && (
          <Thread slices={slices} t0={limits.now} grow={p.grow} unit={cfg.currency} scrub={scrub} preset={form.preset} hint={!scrubbed}
            onScrub={(v) => { setScrub(v); setScrubbed(true); }} />
        )}
        <p className="fine">
          {p?.grow ? 'Illustration at 5% a year, minus our 10% share of rewards. Rewards vary and are not guaranteed.' : form.preset === 'family' ? 'Nothing happens until the day. Then it arrives on its own.' : 'Each payment arrives on its date, on its own.'}
        </p>

        <button className="cta" onClick={() => (d.errors.amount || d.issues.length ? setShow(true) : go('seal'))}>Continue</button>
        <button className="ghost" onClick={() => go('who')}>Back</button>
      </section>
    );
  }

  // ------------------------------------------------------------------ step 3
  const last = p ? lastUnlock(p) : 0;
  const rows: Array<[string, string]> = p ? [
    ['For', form.preset === 'drop' ? `${p.label} · ${p.tranches.length} ${p.tranches.length === 1 ? 'person' : 'people'}` : p.label],
    form.preset === 'pay' ? ['Paid', `${p.tranches.length} times, from ${fmtDate(p.tranches[0]!.unlockTime)}`] : ['Arrives', `${fmtDate(last)} · ${localTimeOfUnlock(last)} your time`],
    ['Locked', `${fmtMon(principal(p))} ${cfg.currency}`],
    ['While it waits', p.grow ? 'Staked on Monad' : 'Held safely, untouched'],
    ['Changes', p.revocable ? 'You can cancel. It takes 7 days and they’re told.' : 'Permanent. It can’t be cancelled.'],
    ['Delivery reserve', `${fmtMon(reserve(p), 6)} ${cfg.currency}, unused part comes back`],
  ] : [];
  return (
    <section>
      <Dots n={dots} />
      <h1 ref={h1} tabIndex={-1}>Seal it.</h1>
      <p className="lede">One last look. After this, you don’t have to do anything.</p>
      <dl className="summary">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>

      {form.preset === 'family' && (
        <>
          <label className="lbl" htmlFor="note">A note to open with it</label>
          <textarea id="note" className="note" maxLength={200} value={form.note} placeholder={`Happy birthday, ${form.name.trim() || 'Maya'}. We’re so proud of you.`} onChange={(ev) => set('note', ev.target.value)} />
          <label className="lbl" htmlFor="from">From (optional)</label>
          <input id="from" className="field" style={{ fontSize: 22 }} value={form.from} maxLength={40} placeholder="Mum" onChange={(ev) => set('from', ev.target.value)} />
        </>
      )}

      {!p?.grow && (
        <Switch checked={form.permanent} onChange={(v) => set('permanent', v)} title="Make it permanent" sub="Nobody can cancel it, including you. Recipients can trust it completely." />
      )}

      <span className="lbl">Pay from</span>
      <Chips<string> label="Pay from" value="monad" onChange={() => {}} items={[['monad', cfg.mode === 'sim' ? 'Demo wallet' : 'Monad wallet']]} />
      <p className="small" style={{ marginTop: 10 }}>Funding from other chains arrives with the next update.</p>
      <p className="err" role="alert">{error ?? ''}</p>

      <button className="cta dawn" disabled={busy || !p || d.issues.length > 0} onClick={lock}>
        {busy ? 'Sealing…' : account || cfg.mode === 'sim' ? 'Lock it in' : 'Connect wallet & lock it in'}
      </button>
      {p && <p className="small" style={{ textAlign: 'center', marginTop: 12 }}>You’ll send {fmtMon(requiredValue(p), 6)} {cfg.currency} plus the network fee.</p>}
      <button className="ghost" disabled={busy} onClick={() => go('grow')}>Back</button>
    </section>
  );
}

function Dots({ n }: { n: number }) {
  return (
    <div className="thread" aria-hidden="true" style={{ padding: '0 0 22px' }}>
      {[1, 2, 3, 4].map((i) => <span key={i} className={i <= n ? 'on' : ''} />)}
    </div>
  );
}
