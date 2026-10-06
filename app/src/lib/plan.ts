import { Address } from './format.js';
import { DAY, monthlyDates } from './dates.js';
import { PresetKey } from './share.js';

export const MAX_TRANCHES = 64;
export const HORIZON = 100 * 365 * DAY;
/** Chain time moves between "now" in the UI and the block that includes the transaction. */
export const SAFETY_SECONDS = 120;

export interface PlanTranche {
  recipient: Address;
  amount: bigint;
  /** Unix seconds. */
  unlockTime: number;
}

/** Everything the user decided, in the terms the contracts understand. */
export interface Plan {
  preset: PresetKey;
  label: string;
  moment?: string;
  note?: string;
  from?: string;
  tranches: PlanTranche[];
  /** Stake native tranches on Monad while they wait (makes the schedule permanent). */
  grow: boolean;
  /** Creator may cancel with a 7-day notice. Always false when `grow`. */
  revocable: boolean;
  fallback?: Address;
  /** Native tip per keeper step; the creator reserves it up front and gets the unused part back. */
  tip: bigint;
  fundingWindow: number;
  /** Claim-link key when the recipient has no wallet yet. */
  key?: `0x${string}`;
}

export interface Limits {
  /** Chain time, unix seconds. */
  now: number;
  minWindow: number;
  maxWindow: number;
  maxTip: bigint;
  /** Seconds a tranche must be away to be staked; null when staking is not available on this deployment. */
  stakeLead: number | null;
}

/** Keeper tip slots reserved per tranche: deliver (idle) or prepare + settle + deliver (staked). */
export const tipSlots = (grow: boolean): bigint => (grow ? 3n : 1n);

export const principal = (p: Plan): bigint => p.tranches.reduce((s, t) => s + t.amount, 0n);
export const reserve = (p: Plan): bigint => p.tip * tipSlots(p.grow) * BigInt(p.tranches.length);
/** Exactly what `ScheduleFactory.create{value}` must receive when funding in the same transaction. */
export const requiredValue = (p: Plan): bigint => principal(p) + reserve(p);

export const lastUnlock = (p: Plan): number => p.tranches.reduce((m, t) => Math.max(m, t.unlockTime), 0);
export const firstUnlock = (p: Plan): number => p.tranches.reduce((m, t) => Math.min(m, t.unlockTime), Infinity);

/** Tranches that would really be staked (the vault leaves nearer ones liquid). */
export const stakeableCount = (p: Plan, l: Limits): number =>
  l.stakeLead === null ? 0 : p.tranches.filter((t) => t.unlockTime >= l.now + SAFETY_SECONDS + l.stakeLead!).length;

/** Human-readable reasons the contract would reject this plan; empty means it is good to send. */
export function problems(p: Plan, l: Limits): string[] {
  const out: string[] = [];
  const n = p.tranches.length;
  if (n === 0) out.push('Add at least one payment.');
  if (n > MAX_TRANCHES) out.push(`A schedule can have at most ${MAX_TRANCHES} payments.`);
  if (p.fundingWindow < l.minWindow || p.fundingWindow > l.maxWindow) out.push('The funding window is outside the allowed range.');
  if (p.tip > l.maxTip) out.push('The delivery reserve is higher than allowed.');

  const earliestAllowed = l.now + p.fundingWindow + SAFETY_SECONDS;
  p.tranches.forEach((t, i) => {
    const at = n > 1 ? ` (payment ${i + 1})` : '';
    if (t.amount <= 0n) out.push(`The amount must be more than zero${at}.`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(t.recipient) || /^0x0{40}$/.test(t.recipient)) out.push(`That recipient address is not valid${at}.`);
    if (t.unlockTime <= earliestAllowed) out.push(`The date must be in the future${at}.`);
    if (t.unlockTime > l.now + HORIZON) out.push(`The date is too far away${at}.`);
  });

  if (p.grow) {
    if (l.stakeLead === null) out.push('Growing is not available on this network.');
    else if (stakeableCount(p, l) === 0) out.push(`Growing needs the date to be at least ${Math.ceil(l.stakeLead / DAY)} days away.`);
    if (p.revocable) out.push('A growing schedule is permanent, so it cannot also be cancellable.');
  }
  for (let i = 1; i < n; i++) if (p.tranches[i]!.unlockTime < p.tranches[i - 1]!.unlockTime) { out.push('Payments must be in date order.'); break; }
  return out;
}

// ---------------------------------------------------------------- presets: form values -> tranches

/** Family milestone: one recipient, one date. */
export function familyTranches(recipient: Address, amount: bigint, unlockTime: number): PlanTranche[] {
  return [{ recipient, amount, unlockTime }];
}

/** Pay someone monthly: `months` payments of `amount`, first on `start`, each computed from the start date. */
export function payTranches(recipient: Address, amount: bigint, start: number, months: number): PlanTranche[] {
  return monthlyDates(start, months).map((unlockTime) => ({ recipient, amount, unlockTime }));
}

/** Community drop: the same amount to every address on one date. */
export function dropTranches(recipients: Address[], amount: bigint, unlockTime: number): PlanTranche[] {
  return recipients.map((recipient) => ({ recipient, amount, unlockTime }));
}

/** The default tip: small, bounded by what the factory allows. */
export const defaultTip = (maxTip: bigint, configured: bigint): bigint => (configured > maxTip ? maxTip : configured);
