import { describe, expect, it } from 'vitest';
import { DAY, parseISODate } from '../src/lib/dates.js';
import {
  defaultTip, dropTranches, familyTranches, lastUnlock, Limits, MAX_TRANCHES, payTranches, Plan, principal, problems, requiredValue, reserve,
  SAFETY_SECONDS, stakeableCount, tipSlots,
} from '../src/lib/plan.js';

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;
const MON = 10n ** 18n;
const NOW = 1_800_000_000;
const limits: Limits = { now: NOW, minWindow: 60, maxWindow: 30 * DAY, maxTip: MON, stakeLead: 3 * DAY };

const plan = (o: Partial<Plan> = {}): Plan => ({
  preset: 'family', label: 'Maya', tranches: familyTranches(A, 5000n * MON, NOW + 400 * DAY), grow: false, revocable: true, tip: MON / 100n, fundingWindow: 60, ...o,
});

describe('value the factory will demand', () => {
  it('idle: principal + 1 tip slot per tranche', () => {
    const p = plan({ tranches: dropTranches([A, B, A], 2n * MON, NOW + 400 * DAY) });
    expect(principal(p)).toBe(6n * MON);
    expect(reserve(p)).toBe(3n * (MON / 100n));
    expect(requiredValue(p)).toBe(6n * MON + 3n * (MON / 100n));
  });
  it('growing: 3 slots per tranche (prepare, settle, deliver), matching the contract', () => {
    expect(tipSlots(false)).toBe(1n);
    expect(tipSlots(true)).toBe(3n);
    const p = plan({ grow: true, revocable: false });
    expect(requiredValue(p)).toBe(5000n * MON + 3n * (MON / 100n));
  });
  it('zero tip is allowed and adds nothing', () => expect(requiredValue(plan({ tip: 0n }))).toBe(5000n * MON));
});

describe('validation mirrors the contract', () => {
  it('accepts a normal plan', () => expect(problems(plan(), limits)).toEqual([]));

  it('needs at least one and at most 64 payments', () => {
    expect(problems(plan({ tranches: [] }), limits)[0]).toMatch(/at least one/);
    const many = dropTranches(Array.from({ length: MAX_TRANCHES + 1 }, () => A), MON, NOW + 400 * DAY);
    expect(problems(plan({ tranches: many }), limits).join()).toMatch(/at most 64/);
    expect(problems(plan({ tranches: many.slice(0, MAX_TRANCHES) }), limits)).toEqual([]);
  });

  it('dates must clear the funding window plus a safety margin (the contract requires unlock > deadline)', () => {
    const edge = NOW + 60 + SAFETY_SECONDS;
    expect(problems(plan({ tranches: familyTranches(A, MON, edge) }), limits).join()).toMatch(/future/);
    expect(problems(plan({ tranches: familyTranches(A, MON, edge + 1) }), limits)).toEqual([]);
    expect(problems(plan({ tranches: familyTranches(A, MON, NOW - DAY) }), limits).join()).toMatch(/future/);
  });

  it('rejects dates beyond the 100-year horizon', () => {
    expect(problems(plan({ tranches: familyTranches(A, MON, NOW + 101 * 365 * DAY) }), limits).join()).toMatch(/too far/);
  });

  it('rejects zero amounts and bad recipients, naming the payment when there are several', () => {
    const t = [...dropTranches([A, B], MON, NOW + 400 * DAY)];
    t[1] = { ...t[1]!, amount: 0n };
    t[0] = { ...t[0]!, recipient: ('0x' + '0'.repeat(40)) as never };
    const msgs = problems(plan({ tranches: t }), limits);
    expect(msgs.some((m) => /payment 2/.test(m) && /zero/.test(m))).toBe(true);
    expect(msgs.some((m) => /payment 1/.test(m) && /address/.test(m))).toBe(true);
    expect(problems(plan({ tranches: familyTranches('0x123' as never, MON, NOW + 400 * DAY) }), limits).join()).toMatch(/address/);
  });

  it('keeps the funding window and tip inside what the factory allows', () => {
    expect(problems(plan({ fundingWindow: 30 }), limits).join()).toMatch(/funding window/);
    expect(problems(plan({ fundingWindow: 31 * DAY }), limits).join()).toMatch(/funding window/);
    expect(problems(plan({ tip: MON + 1n }), limits).join()).toMatch(/reserve/);
  });

  it('requires payments in date order (the keeper and the UI both rely on it)', () => {
    const t = [{ recipient: A, amount: MON, unlockTime: NOW + 500 * DAY }, { recipient: A, amount: MON, unlockTime: NOW + 400 * DAY }];
    expect(problems(plan({ tranches: t }), limits).join()).toMatch(/date order/);
  });
});

describe('growing', () => {
  it('is only valid when something can actually be staked', () => {
    const soon = plan({ grow: true, revocable: false, tranches: familyTranches(A, MON, NOW + 2 * DAY) });
    expect(problems(soon, limits).join()).toMatch(/at least 3 days/);
    expect(stakeableCount(soon, limits)).toBe(0);
    const far = plan({ grow: true, revocable: false, tranches: familyTranches(A, MON, NOW + 10 * DAY) });
    expect(problems(far, limits)).toEqual([]);
    expect(stakeableCount(far, limits)).toBe(1);
  });
  it('counts only the tranches far enough away', () => {
    const t = payTranches(A, MON, NOW + DAY, 12);
    const p = plan({ grow: true, revocable: false, tranches: t });
    const n = stakeableCount(p, limits);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(12);
  });
  it('cannot be combined with cancel', () => {
    expect(problems(plan({ grow: true, revocable: true, tranches: familyTranches(A, MON, NOW + 10 * DAY) }), limits).join()).toMatch(/cannot also be cancellable/);
  });
  it('is rejected when the network offers no staking', () => {
    expect(problems(plan({ grow: true, revocable: false }), { ...limits, stakeLead: null }).join()).toMatch(/not available/);
  });
});

describe('preset builders', () => {
  const d = (s: string) => parseISODate(s)!;
  it('monthly payments are computed from the start date and keep the amount', () => {
    const t = payTranches(A, 1200n * MON, d('2030-01-31'), 4);
    expect(t.map((x) => new Date(x.unlockTime * 1000).toISOString().slice(0, 10))).toEqual(['2030-01-31', '2030-02-28', '2030-03-31', '2030-04-30']);
    expect(principal(plan({ tranches: t }))).toBe(4800n * MON);
    expect(lastUnlock(plan({ tranches: t }))).toBe(d('2030-04-30'));
  });
  it('a community drop gives every address the same amount on the same date', () => {
    const t = dropTranches([A, B], 100n * MON, d('2030-05-01'));
    expect(t.map((x) => x.recipient)).toEqual([A, B]);
    expect(new Set(t.map((x) => x.unlockTime)).size).toBe(1);
    expect(principal(plan({ tranches: t }))).toBe(200n * MON);
  });
  it('the default tip never exceeds the factory cap', () => {
    expect(defaultTip(5n, 10n)).toBe(5n);
    expect(defaultTip(50n, 10n)).toBe(10n);
  });
});
