import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { SimAdapter } from '../src/chain/sim.js';
import { Stage, State, Status } from '../src/chain/types.js';
import { dropTranches, familyTranches, Plan, requiredValue } from '../src/lib/plan.js';
import { Address } from '../src/lib/format.js';

const MON = 10n ** 18n;
const DAY = 86_400;
const T0 = 1_800_000_000;
const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const make = (storage = mem()) => {
  const clock = { t: T0 };
  const sim = new SimAdapter(() => clock.t, storage);
  return { sim, clock, storage };
};
const plan = (o: Partial<Plan> = {}): Plan => ({
  preset: 'family', label: 'Maya', tranches: familyTranches(A, 100n * MON, T0 + 30 * DAY), grow: false, revocable: true, tip: MON / 100n, fundingWindow: 60, ...o,
});

describe('create', () => {
  it('charges exactly the required value (+ a small fee) and reads back', async () => {
    const { sim } = make();
    const me = await sim.connect();
    const before = await sim.balance(me);
    const p = plan();
    const { vault } = await sim.create(p);
    expect(before - (await sim.balance(me))).toBeGreaterThanOrEqual(requiredValue(p));
    expect(before - (await sim.balance(me))).toBeLessThan(requiredValue(p) + MON / 100n);
    const v = await sim.get(vault);
    expect(v).toMatchObject({ creator: me, staked: false, revocable: true, state: State.Active, tipPool: MON / 100n });
    expect(v.tranches[0]).toMatchObject({ recipient: A, amount: 100n * MON, status: Status.Pending });
  });

  it('applies the same validation as the real thing, and checks the balance', async () => {
    const { sim } = make();
    await expect(sim.create(plan({ tranches: familyTranches(A, MON, T0 - DAY) }))).rejects.toThrow(/future/);
    await expect(sim.create(plan({ tranches: familyTranches(A, 1_000_000n * MON, T0 + 30 * DAY) }))).rejects.toThrow(/not enough/);
    await expect(sim.get('0x000000000000000000000000000000000000dEaD')).rejects.toThrow(/not a Kindred schedule/i);
  });
});

describe('time and the simulated keeper', () => {
  it('delivers exactly at unlock, pays the recipient exactly, closes the schedule and returns the tip', async () => {
    const { sim } = make();
    const me = await sim.connect();
    const { vault } = await sim.create(plan());
    const afterCreate = await sim.balance(me);
    await sim.travelTo(T0 + 30 * DAY - 1);
    expect((await sim.get(vault)).tranches[0]!.status).toBe(Status.Pending);
    await sim.travelTo(T0 + 30 * DAY);
    const v = await sim.get(vault);
    expect(v.tranches[0]!.status).toBe(Status.Delivered);
    expect(v.state).toBe(State.Closed);
    expect(await sim.balance(A)).toBe(100n * MON);
    expect(v.deliveries[0]).toMatchObject({ id: 0, how: 'executed' });
    expect(v.deliveries[0]!.blockTime - (T0 + 30 * DAY)).toBeLessThanOrEqual(5);
    expect((await sim.balance(me)) - afterCreate).toBe(0n); // the keeper earned the tip, so there is nothing to refund
  });

  it('with the keeper off nothing is pushed, yet the recipient can still claim on the day', async () => {
    const { sim } = make();
    await sim.connect();
    const { vault } = await sim.create(plan());
    sim.setKeeper(false);
    await sim.travelTo(T0 + 31 * DAY);
    expect((await sim.get(vault)).tranches[0]!.status).toBe(Status.Pending);

    sim.actAs(B);
    await expect(sim.claim(vault, 0)).rejects.toThrow(/Only the recipient/);
    sim.actAs(A);
    await expect(sim.claim(vault, 0)).rejects.toThrow(/enough/); // a recipient needs a little gas, as on a real chain
    const me = await sim.connect();
    await sim.fundGas(A, MON / 10n);
    const creatorBefore = await sim.balance(me);
    sim.actAs(A);
    await sim.claim(vault, 0);
    const v = await sim.get(vault);
    expect(v.deliveries[0]!.how).toBe('claimed');
    expect(await sim.balance(A)).toBeGreaterThan(100n * MON);
    expect((await sim.balance(me)) - creatorBefore).toBe(MON / 100n); // nobody was tipped, so the reserve returns to the creator
  });

  it('claiming early is refused with the same sentence as the contract', async () => {
    const { sim } = make();
    await sim.connect();
    const { vault } = await sim.create(plan());
    await sim.fundGas(A, MON / 10n);
    sim.actAs(A);
    await expect(sim.claim(vault, 0)).rejects.toThrow(/not unlocked/i);
  });

  it('turning the keeper back on catches up on everything that is due', async () => {
    const { sim } = make();
    await sim.connect();
    const { vault } = await sim.create(plan());
    sim.setKeeper(false);
    await sim.travelTo(T0 + 40 * DAY);
    sim.setKeeper(true);
    expect((await sim.get(vault)).tranches[0]!.status).toBe(Status.Delivered);
  });

  it('a monthly schedule delivers payment by payment', async () => {
    const { sim } = make();
    await sim.connect();
    const t = [30, 60, 90].map((d) => ({ recipient: A, amount: 10n * MON, unlockTime: T0 + d * DAY }));
    const { vault } = await sim.create(plan({ preset: 'pay', tranches: t }));
    await sim.travelTo(T0 + 61 * DAY);
    const v = await sim.get(vault);
    expect(v.tranches.map((x) => x.status)).toEqual([Status.Delivered, Status.Delivered, Status.Pending]);
    expect(v.state).toBe(State.Active);
    expect(await sim.balance(A)).toBe(20n * MON);
  });
});

describe('growing schedules', () => {
  const growPlan = (days = 365) => plan({ grow: true, revocable: false, tranches: familyTranches(A, 1000n * MON, T0 + days * DAY) });

  it('start staked, show a growing position, begin unbonding 48 hours ahead, then pay principal plus growth', async () => {
    const { sim } = make();
    await sim.connect();
    const { vault } = await sim.create(growPlan());
    let v = await sim.get(vault);
    expect(v.staked && !v.revocable).toBe(true);
    expect(v.tranches[0]!.stage).toBe(Stage.Staked);
    expect(v.tipPool).toBe(3n * (MON / 100n));
    expect(v.position!.stake).toBe(1000n * MON);

    await sim.travelTo(T0 + 180 * DAY);
    v = await sim.get(vault);
    expect(v.position!.rewards).toBeGreaterThan(0n);

    await sim.travelTo(T0 + 365 * DAY - 2 * DAY);
    expect((await sim.get(vault)).tranches[0]!.stage).toBe(Stage.Unbonding);
    await sim.travelTo(T0 + 365 * DAY);
    v = await sim.get(vault);
    expect(v.tranches[0]!.status).toBe(Status.Delivered);
    const got = await sim.balance(A);
    expect(got).toBeGreaterThan(1000n * MON);
    expect(got).toBeLessThan(1100n * MON); // about 4.6 % for one year at the illustrated net rate
    expect(v.tranches[0]!.payout).toBe(got);
  });

  it('only stakes tranches far enough away; closer ones stay liquid', async () => {
    const { sim } = make();
    await sim.connect();
    const t = [{ recipient: A, amount: MON, unlockTime: T0 + 2 * DAY }, { recipient: A, amount: MON, unlockTime: T0 + 90 * DAY }];
    const { vault } = await sim.create(plan({ grow: true, revocable: false, tranches: t }));
    expect((await sim.get(vault)).tranches.map((x) => x.stage)).toEqual([Stage.Idle, Stage.Staked]);
  });
});

describe('cancel', () => {
  it('needs 7 days, can be aborted, and refunds only what has not unlocked', async () => {
    const { sim } = make();
    const me = await sim.connect();
    const t = [{ recipient: A, amount: 5n * MON, unlockTime: T0 + 2 * DAY }, { recipient: B, amount: 7n * MON, unlockTime: T0 + 60 * DAY }];
    const { vault } = await sim.create(plan({ preset: 'drop', tranches: t }));
    await sim.requestCancel(vault);
    await expect(sim.requestCancel(vault)).rejects.toThrow(/already waiting/);
    await expect(sim.finalizeCancel(vault)).rejects.toThrow(/7-day/);
    await sim.abortCancel(vault);
    await sim.requestCancel(vault);
    await sim.travelTo(T0 + 7 * DAY);
    const before = await sim.balance(me);
    await sim.finalizeCancel(vault);
    const v = await sim.get(vault);
    expect(v.tranches.map((x) => x.status)).toEqual([Status.Delivered, Status.Cancelled]); // the first unlocked during the wait
    expect((await sim.balance(me)) - before).toBeGreaterThan(7n * MON - MON / 10n);
    expect(v.state).toBe(State.Closed);
  });

  it('is refused on a permanent schedule and for non-creators', async () => {
    const { sim } = make();
    await sim.connect();
    const perm = await sim.create(plan({ revocable: false }));
    await expect(sim.requestCancel(perm.vault)).rejects.toThrow(/permanent/);
    const open = await sim.create(plan());
    sim.actAs(B);
    await expect(sim.requestCancel(open.vault)).rejects.toThrow(/Only the person who created/);
  });
});

describe('claim links', () => {
  it('the recipient is the key\'s address; funds can be claimed with the key and moved to a wallet', async () => {
    const { sim } = make();
    await sim.connect();
    const key = generatePrivateKey();
    const addr = privateKeyToAccount(key).address;
    const { vault } = await sim.create(plan({ tranches: familyTranches(addr, 50n * MON, T0 + 30 * DAY) }));
    await sim.fundGas(addr, MON / 10n);
    sim.setKeeper(false);
    await sim.travelTo(T0 + 30 * DAY);
    await sim.claim(vault, 0, key);
    await sim.moveAll(key, B);
    expect(await sim.balance(B)).toBeGreaterThan(50n * MON);
    await expect(sim.moveAll(key, B)).rejects.toThrow(/nothing to move/);
  });
});

describe('persistence', () => {
  it('survives a reload, including the clock and the keeper switch', async () => {
    const first = make();
    await first.sim.connect();
    const { vault } = await first.sim.create(plan());
    first.sim.setKeeper(false);
    await first.sim.travelTo(T0 + 10 * DAY);

    const second = new SimAdapter(() => T0, first.storage);
    expect(second.isKeeperOn()).toBe(false);
    const v = await second.get(vault);
    expect(v.tranches[0]!.amount).toBe(100n * MON); // bigint round-trips
    expect(v.chainNow).toBe(T0 + 10 * DAY);
    expect(await second.listByCreator(v.creator)).toEqual([vault]);
  });

  it('ignores corrupt stored state instead of crashing', async () => {
    const storage = mem();
    storage.setItem('kindred-sim-v1', '{ broken');
    const sim = new SimAdapter(() => T0, storage);
    expect(await sim.connect()).toMatch(/^0x/);
  });
});

describe('a drop pays everyone', () => {
  it('delivers every recipient on the day', async () => {
    const { sim } = make();
    await sim.connect();
    const { vault } = await sim.create(plan({ preset: 'drop', tranches: dropTranches([A, B], 10n * MON, T0 + 20 * DAY) }));
    await sim.travelTo(T0 + 20 * DAY);
    expect([await sim.balance(A), await sim.balance(B)]).toEqual([10n * MON, 10n * MON]);
    expect((await sim.get(vault)).state).toBe(State.Closed);
  });
});
