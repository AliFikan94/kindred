import { describe, expect, it } from 'vitest';
import { planAll, planVault, SWEEP_GRACE } from '../src/planner.js';
import { Address, Kind, Stage, State, Status, TrancheSnap, VaultSnap } from '../src/types.js';

const V1 = '0x00000000000000000000000000000000000000a1' as Address;
const V2 = '0x00000000000000000000000000000000000000a2' as Address;
const DAY = 86_400n;
const NOW = 1_000_000n;
const opts = { sweep: false };

const t = (id: number, unlock: bigint, o: Partial<TrancheSnap> = {}): TrancheSnap => ({
  id, unlockTime: unlock, kind: Kind.Native, status: Status.Pending, stage: Stage.Idle, ...o,
});
const vault = (o: Partial<VaultSnap> & { tranches: TrancheSnap[] }): VaultSnap => ({
  address: V1, staked: false, state: State.Active, fundingDeadline: 0n, prepareLead: 0n, ...o,
});
const kinds = (a: { kind: string; id?: number }[]) => a.map((x) => `${x.kind}${x.id ?? ''}`);

describe('idle vaults', () => {
  it('does nothing before unlock', () => {
    expect(planVault(vault({ tranches: [t(0, NOW + 1n)] }), NOW, opts)).toEqual([]);
  });

  it('executes exactly at the unlock second and after', () => {
    expect(kinds(planVault(vault({ tranches: [t(0, NOW)] }), NOW, opts))).toEqual(['execute0']);
    expect(kinds(planVault(vault({ tranches: [t(0, NOW - 50n)] }), NOW, opts))).toEqual(['execute0']);
  });

  it('only plans tranches that are due, skipping terminal ones', () => {
    const v = vault({
      tranches: [t(0, NOW - 1n, { status: Status.Delivered }), t(1, NOW - 1n), t(2, NOW + 99n), t(3, NOW - 1n, { status: Status.Cancelled }), t(4, NOW - 1n, { status: Status.Swept })],
    });
    expect(kinds(planVault(v, NOW, opts))).toEqual(['execute1']);
  });

  it('flags Claimable tranches as retries', () => {
    const [a] = planVault(vault({ tranches: [t(0, NOW - 1n, { status: Status.Claimable })] }), NOW, opts);
    expect(a?.retry).toBe(true);
    const [b] = planVault(vault({ tranches: [t(0, NOW - 1n)] }), NOW, opts);
    expect(b?.retry).toBe(false);
  });

  it('ignores closed vaults entirely', () => {
    expect(planVault(vault({ state: State.Closed, tranches: [t(0, NOW - 1n)] }), NOW, opts)).toEqual([]);
  });

  it('never sweeps unless enabled, and only after the grace period', () => {
    const v = vault({ tranches: [t(0, NOW - SWEEP_GRACE)] });
    expect(kinds(planVault(v, NOW, { sweep: false }))).toEqual(['execute0']);
    expect(kinds(planVault(v, NOW, { sweep: true }))).toEqual(['execute0', 'sweep0']);
    const early = vault({ tranches: [t(0, NOW - SWEEP_GRACE + 1n)] });
    expect(kinds(planVault(early, NOW, { sweep: true }))).toEqual(['execute0']);
  });

  it('plans non-native tranches the same way', () => {
    const v = vault({ tranches: [t(0, NOW - 1n, { kind: Kind.ERC20 }), t(1, NOW - 1n, { kind: Kind.ERC721 })] });
    expect(kinds(planVault(v, NOW, opts))).toEqual(['execute0', 'execute1']);
  });
});

describe('funding', () => {
  it('tries to activate an unfunded vault inside its funding window', () => {
    const v = vault({ state: State.AwaitingFunds, fundingDeadline: NOW + 5n, tranches: [t(0, NOW + DAY)] });
    expect(kinds(planVault(v, NOW, opts))).toEqual(['activate']);
    expect(kinds(planVault(v, NOW + 5n, opts))).toEqual(['activate']); // deadline second is still valid
  });

  it('refunds after the funding deadline instead', () => {
    const v = vault({ state: State.AwaitingFunds, fundingDeadline: NOW - 1n, tranches: [t(0, NOW + DAY)] });
    expect(kinds(planVault(v, NOW, opts))).toEqual(['refund']);
  });

  it('plans nothing else for an unfunded vault, even if tranches look due', () => {
    const v = vault({ state: State.AwaitingFunds, fundingDeadline: NOW + 10n, tranches: [t(0, NOW - 5n)] });
    expect(kinds(planVault(v, NOW, opts))).toEqual(['activate']);
  });
});

describe('staked vaults', () => {
  const LEAD = 2n * DAY;
  const sv = (tranches: TrancheSnap[], o: Partial<VaultSnap> = {}) => vault({ staked: true, prepareLead: LEAD, tranches, ...o });

  it('prepares only inside the prepare window', () => {
    const unlock = NOW + LEAD + 100n;
    const early = sv([t(0, unlock, { stage: Stage.Staked })]);
    expect(planVault(early, NOW, opts)).toEqual([]);
    expect(kinds(planVault(early, NOW + 100n, opts))).toEqual(['prepare0']); // window opens exactly at unlock - lead
    expect(planVault(early, NOW + 99n, opts)).toEqual([]);
  });

  it('does not prepare a tranche that is not staked, is already unbonding, or is non-native', () => {
    const v = sv([
      t(0, NOW + 10n, { stage: Stage.Idle }),
      t(1, NOW + 10n, { stage: Stage.Unbonding }),
      t(2, NOW + 10n, { stage: Stage.Staked, kind: Kind.ERC20 }),
      t(3, NOW + 10n, { stage: Stage.Liquid }),
    ]);
    expect(kinds(planVault(v, NOW, opts).filter((a) => a.kind === 'prepare'))).toEqual([]);
  });

  it('executes unbonding and unprepared tranches once due (the contract decides readiness)', () => {
    const v = sv([t(0, NOW - 1n, { stage: Stage.Unbonding }), t(1, NOW - 1n, { stage: Stage.Staked })]);
    expect(kinds(planVault(v, NOW, opts)).filter((k) => k.startsWith('execute'))).toEqual(['execute0', 'execute1']);
  });

  it('stakes eligible idle native tranches (e.g. a funded draft), but not ones too close', () => {
    const far = sv([t(0, NOW + LEAD + DAY, { stage: Stage.Idle })]);
    expect(kinds(planVault(far, NOW, opts))).toEqual(['stakeAll']);
    const close = sv([t(0, NOW + LEAD + DAY - 1n, { stage: Stage.Idle })]);
    expect(planVault(close, NOW, opts)).toEqual([]);
  });

  it('never asks an idle vault to stake', () => {
    const v = vault({ tranches: [t(0, NOW + 100n * DAY, { stage: Stage.Idle })] });
    expect(planVault(v, NOW, opts)).toEqual([]);
  });
});

describe('ordering across vaults', () => {
  it('serves the most overdue action first', () => {
    const a = vault({ address: V1, tranches: [t(0, NOW - 10n)] });
    const b = vault({ address: V2, tranches: [t(0, NOW - 500n)] });
    const plan = planAll([a, b], NOW, opts);
    expect(plan.map((x) => x.vault)).toEqual([V2, V1]);
  });

  it('interleaves prepare and execute by their own due times', () => {
    const lead = 2n * DAY;
    const staked = vault({ address: V1, staked: true, prepareLead: lead, tranches: [t(0, NOW + lead - 5n, { stage: Stage.Staked })] }); // prepare due 5s ago
    const idle = vault({ address: V2, tranches: [t(0, NOW - 1n)] }); // execute due 1s ago
    expect(planAll([idle, staked], NOW, opts).map((x) => x.kind)).toEqual(['prepare', 'execute']);
  });
});
