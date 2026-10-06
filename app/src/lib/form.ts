import { privateKeyToAccount } from 'viem/accounts';
import { addYears, DAY, ordinal, parseISODate, toISODate } from './dates.js';
import { Address, parseAddress, parseAddressList, parseMon } from './format.js';
import { defaultTip, dropTranches, familyTranches, Limits, MAX_TRANCHES, payTranches, Plan, PlanTranche, problems, SAFETY_SECONDS, stakeableCount } from './plan.js';
import { PresetKey } from './share.js';

export type Moment = '18' | '21' | 'custom' | 'soon';
export type FieldKey = 'name' | 'dob' | 'custom' | 'wallet' | 'start' | 'addresses' | 'dropDate' | 'amount';

export interface Form {
  preset: PresetKey;
  name: string;
  from: string;
  // family
  dob: string;
  moment: Moment;
  custom: string;
  /** "Arrives in N minutes": for showing a real delivery live (demo deployments only). */
  soonMinutes: number;
  recipientMode: 'link' | 'wallet';
  wallet: string;
  // pay
  start: string;
  months: number;
  // drop
  addresses: string;
  dropDate: string;
  // all
  amount: string;
  grow: boolean;
  note: string;
  permanent: boolean;
}

export interface FormCtx {
  limits: Limits;
  /** Configured tip per keeper step (capped by the factory's maximum inside `derive`). */
  tip: bigint;
  /** Address of the claim-link key generated for this session. */
  giftKey: `0x${string}`;
}

export interface Derived {
  plan: Plan | null;
  errors: Partial<Record<FieldKey, string>>;
  /** Reasons the contract would refuse the plan (only filled once the fields themselves are fine). */
  issues: string[];
  /** Whether switching growth on would actually stake anything. */
  growEligible: boolean;
  momentLabel: string;
}

const iso = (sec: number) => toISODate(sec);

export function defaultForm(now: number, preset: PresetKey = 'family'): Form {
  const base = Math.floor(now / DAY) * DAY;
  return {
    preset,
    name: '',
    from: '',
    dob: iso(addYears(base, -6) - 100 * DAY),
    moment: '18',
    custom: iso(addYears(base, 5)),
    soonMinutes: 3,
    recipientMode: 'link',
    wallet: '',
    start: iso(base + 35 * DAY),
    months: 6,
    addresses: '',
    dropDate: iso(base + 60 * DAY),
    amount: preset === 'family' ? '5000' : preset === 'pay' ? '1200' : '100',
    grow: preset === 'family',
    note: '',
    permanent: false,
  };
}

export const giftAddress = (key: `0x${string}`): Address => privateKeyToAccount(key).address;

export function derive(f: Form, c: FormCtx): Derived {
  const errors: Derived['errors'] = {};
  const { limits } = c;
  const now = limits.now;
  const name = f.name.trim();
  if (!name) errors.name = f.preset === 'drop' ? 'Give the community a name.' : 'Add a name.';
  else if (name.length > 40) errors.name = 'Keep the name under 40 characters.';

  const amount = parseMon(f.amount);
  if (amount === null) errors.amount = 'Enter an amount above zero.';

  let tranches: PlanTranche[] = [];
  let momentLabel = '';

  if (f.preset === 'family') {
    let unlock: number | null = null;
    if (f.moment === 'soon') {
      unlock = now + limits.minWindow + SAFETY_SECONDS + 60 + Math.max(1, f.soonMinutes) * 60;
      momentLabel = `in ${f.soonMinutes} minutes`;
    } else if (f.moment === 'custom') {
      unlock = parseISODate(f.custom);
      if (unlock === null) errors.custom = 'Pick a valid date.';
      momentLabel = 'a special day';
    } else {
      const dob = parseISODate(f.dob);
      if (dob === null) errors.dob = 'Enter a valid date of birth.';
      else if (dob > now) errors.dob = 'That date of birth is in the future.';
      else {
        unlock = addYears(dob, Number(f.moment));
        if (unlock <= now + limits.minWindow + SAFETY_SECONDS) errors.dob = `They are already past their ${ordinal(Number(f.moment))} birthday. Choose another day.`;
      }
      momentLabel = `${ordinal(Number(f.moment))} birthday`;
    }
    let recipient: Address | null = null;
    if (f.recipientMode === 'link') recipient = giftAddress(c.giftKey);
    else {
      recipient = parseAddress(f.wallet);
      if (!recipient) errors.wallet = 'Paste their wallet address (it starts with 0x).';
    }
    if (unlock !== null && recipient && amount !== null) tranches = familyTranches(recipient, amount, unlock);
  } else if (f.preset === 'pay') {
    const recipient = parseAddress(f.wallet);
    if (!recipient) errors.wallet = 'Paste their wallet address (it starts with 0x).';
    const start = parseISODate(f.start);
    if (start === null) errors.start = 'Pick a valid date.';
    momentLabel = `${f.months} monthly payments`;
    if (recipient && start !== null && amount !== null) tranches = payTranches(recipient, amount, start, f.months);
  } else {
    const { ok, bad } = parseAddressList(f.addresses);
    if (bad.length) errors.addresses = `${bad.length === 1 ? 'This is not an address' : `${bad.length} entries are not addresses`}: ${bad.slice(0, 2).join(', ')}${bad.length > 2 ? '…' : ''}`;
    else if (ok.length === 0) errors.addresses = 'Paste at least one wallet address.';
    else if (ok.length > MAX_TRANCHES) errors.addresses = `At most ${MAX_TRANCHES} people per drop.`;
    const date = parseISODate(f.dropDate);
    if (date === null) errors.dropDate = 'Pick a valid date.';
    momentLabel = 'community drop';
    if (!bad.length && ok.length && date !== null && amount !== null) tranches = dropTranches(ok, amount, date);
  }

  const hasFieldErrors = Object.keys(errors).length > 0;
  const base: Plan | null = hasFieldErrors || tranches.length === 0
    ? null
    : {
        preset: f.preset,
        label: name,
        moment: momentLabel,
        note: f.preset === 'family' ? f.note.trim() || undefined : undefined,
        from: f.from.trim() || undefined,
        tranches,
        grow: false,
        revocable: !f.permanent,
        tip: defaultTip(limits.maxTip, c.tip),
        fundingWindow: limits.minWindow,
        key: f.preset === 'family' && f.recipientMode === 'link' ? c.giftKey : undefined,
      };

  const growEligible = base !== null && stakeableCount({ ...base, grow: true }, limits) > 0;
  const plan = base ? { ...base, grow: f.grow && growEligible, revocable: !(f.grow && growEligible) && !f.permanent } : null;
  return { plan, errors, issues: plan ? problems(plan, limits) : [], growEligible, momentLabel };
}
