/**
 * The growth curve shown in the UI. It is an ILLUSTRATION with a fixed, labelled assumption
 * (SPEC §7): 5 % a year gross, minus the protocol's 10 % share of rewards. It is never a forecast.
 */
export const GROSS_APY = 0.05;
export const FEE_SHARE = 0.1;
export const NET_APY = GROSS_APY * (1 - FEE_SHARE);
const YEAR = 365.25 * 86_400;

export interface Slice {
  /** Unlock time (unix seconds). */
  t: number;
  /** Principal in whole MON (a float is fine here: this is a picture, not accounting). */
  amount: number;
}

export interface Worth {
  waiting: number;
  arrived: number;
  total: number;
  principal: number;
}

/** Value of one slice staked from `t0` until it unlocks, evaluated at time `t`. */
export const growth = (grow: boolean, t0: number, t: number): number => (grow ? Math.pow(1 + NET_APY, Math.max(0, t - t0) / YEAR) : 1);

export function worthAt(t: number, slices: Slice[], t0: number, grow: boolean): Worth {
  let waiting = 0, arrived = 0, principal = 0;
  for (const s of slices) {
    principal += s.amount;
    if (t >= s.t) arrived += s.amount * growth(grow, t0, s.t);
    else waiting += s.amount * growth(grow, t0, t);
  }
  return { waiting, arrived, total: waiting + arrived, principal };
}
