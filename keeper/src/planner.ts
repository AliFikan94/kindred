import { Action, Kind, Stage, State, Status, VaultSnap } from './types.js';

/** Must match ScheduleVault.SWEEP_GRACE. */
export const SWEEP_GRACE = 365n * 86_400n;
/** Must match StakedScheduleVault.MIN_STAKE_LEAD = PREPARE_LEAD + 1 day. */
export const STAKE_LEAD_EXTRA = 86_400n;

export interface PlanOptions {
  /** Sweeping moves unclaimed funds away from a recipient; off unless explicitly enabled. */
  sweep: boolean;
}

const open = (status: number): boolean => status === Status.Pending || status === Status.Claimable;

/**
 * Pure: given what the chain looks like at chain-time `now`, which permissionless actions are
 * worth attempting? Nothing here touches the network, and nothing here is trusted for safety:
 * every action is simulated before it is sent, and the contract re-checks everything.
 */
export function planVault(v: VaultSnap, now: bigint, opts: PlanOptions): Action[] {
  const base = { vault: v.address, staked: v.staked, trancheCount: v.tranches.length };
  const out: Action[] = [];

  if (v.state === State.Closed) return out;

  if (v.state === State.AwaitingFunds) {
    if (now <= v.fundingDeadline) {
      // A bridge may have delivered funds; activating is permissionless and a no-op revert if short.
      out.push({ ...base, kind: 'activate', dueAt: now });
    } else {
      out.push({ ...base, kind: 'refund', dueAt: v.fundingDeadline });
    }
    return out;
  }

  // ---- Active
  if (v.staked) {
    const stakeLead = v.prepareLead + STAKE_LEAD_EXTRA;
    const needsStake = v.tranches.some(
      (t) =>
        t.kind === Kind.Native && t.status === Status.Pending && t.stage === Stage.Idle && t.unlockTime >= now + stakeLead,
    );
    if (needsStake) out.push({ ...base, kind: 'stakeAll', dueAt: now });

    for (const t of v.tranches) {
      if (t.kind === Kind.Native && t.status === Status.Pending && t.stage === Stage.Staked && now + v.prepareLead >= t.unlockTime) {
        out.push({ ...base, kind: 'prepare', id: t.id, dueAt: t.unlockTime - v.prepareLead });
      }
    }
  }

  for (const t of v.tranches) {
    if (!open(t.status) || now < t.unlockTime) continue;
    out.push({ ...base, kind: 'execute', id: t.id, dueAt: t.unlockTime, retry: t.status === Status.Claimable });
    if (opts.sweep && now >= t.unlockTime + SWEEP_GRACE) {
      out.push({ ...base, kind: 'sweep', id: t.id, dueAt: t.unlockTime + SWEEP_GRACE });
    }
  }
  return out;
}

/** Plans every vault and orders the result: the most overdue action first. */
export function planAll(vaults: VaultSnap[], now: bigint, opts: PlanOptions): Action[] {
  const all = vaults.flatMap((v) => planVault(v, now, opts));
  return all.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));
}
