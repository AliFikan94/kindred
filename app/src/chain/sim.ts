import { privateKeyToAccount } from 'viem/accounts';
import { UserError } from '../lib/errors.js';
import { Address } from '../lib/format.js';
import { Limits, Plan, problems, requiredValue, tipSlots } from '../lib/plan.js';
import { growth } from '../lib/projection.js';
import { Adapter, DeliveryInfo, ScheduleView, Stage, State, Status, TrancheView } from './types.js';

/**
 * A faithful-enough in-browser model of the contracts for trying the product with no wallet:
 * same statuses, same 7-day timelocks, same "keeper delivers, recipient can always claim" rule,
 * and growing tranches that start unbonding 48 h ahead. It is a demo aid. The live adapter is the
 * real thing and is the one under test against the real contracts.
 */
const DAY = 86_400;
const PREPARE_LEAD = 2 * DAY;
const CANCEL_DELAY = 7 * DAY;
const MON = 10n ** 18n;
const GAS_COST = MON / 2000n; // 0.0005 MON per transaction
const DEMO_USER = '0xD3m0000000000000000000000000000000000001' as Address;
const STORE_KEY = 'kindred-sim-v1';

type Hex = `0x${string}`;

interface SimTranche extends TrancheView {
  staked: boolean;
}
interface SimSchedule {
  address: Address;
  creator: Address;
  staked: boolean;
  revocable: boolean;
  state: number;
  fundingDeadline: number;
  cancelRequestedAt: number;
  tipPool: bigint;
  tip: bigint;
  fallback: Address;
  tranches: SimTranche[];
  deliveries: DeliveryInfo[];
  t0: number;
}

interface Snapshot {
  offset: number;
  keeperOn: boolean;
  counter: number;
  balances: Record<string, string>;
  schedules: SimSchedule[];
}

const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? { $big: v.toString() } : v);
const reviver = (_: string, v: unknown) => (v && typeof v === 'object' && '$big' in (v as object) ? BigInt((v as { $big: string }).$big) : v);

export class SimAdapter implements Adapter {
  readonly mode = 'sim' as const;
  private offset = 0;
  private keeperOn = true;
  private counter = 1;
  private acct: Address | null = DEMO_USER;
  private readonly balances = new Map<string, bigint>([[DEMO_USER.toLowerCase(), 100_000n * MON]]);
  private readonly schedules = new Map<string, SimSchedule>();
  private readonly listeners = new Set<(a: Address | null) => void>();

  constructor(
    private readonly realNow: () => number = () => Math.floor(Date.now() / 1000),
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null,
  ) {
    this.load();
  }

  // ------------------------------------------------------------------ clock & persistence
  private now(): number {
    return this.realNow() + this.offset;
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw, reviver) as Snapshot;
      this.offset = s.offset;
      this.keeperOn = s.keeperOn;
      this.counter = s.counter;
      for (const [k, v] of Object.entries(s.balances)) this.balances.set(k, BigInt(v));
      for (const sc of s.schedules) this.schedules.set(sc.address.toLowerCase(), sc);
    } catch { /* a corrupt demo state is simply discarded */ }
  }

  private save(): void {
    try {
      const s: Snapshot = {
        offset: this.offset, keeperOn: this.keeperOn, counter: this.counter,
        balances: Object.fromEntries([...this.balances].map(([k, v]) => [k, v.toString()])),
        schedules: [...this.schedules.values()],
      };
      this.storage?.setItem(STORE_KEY, JSON.stringify(s, replacer));
    } catch { /* storage may be unavailable */ }
  }

  // ------------------------------------------------------------------ simulation controls
  isKeeperOn(): boolean {
    return this.keeperOn;
  }

  setKeeper(on: boolean): void {
    this.keeperOn = on;
    if (on) this.tick();
    this.save();
  }

  async travelTo(unix: number): Promise<void> {
    if (unix > this.now()) this.offset += unix - this.now();
    this.tick();
    this.save();
  }

  /** Switch which simulated person is using the app (a gift link acts as its own key-holder). */
  actAs(addr: Address | null): void {
    this.acct = addr;
    for (const l of this.listeners) l(addr);
  }

  // ------------------------------------------------------------------ the simulated keeper
  private bal(a: string): bigint {
    return this.balances.get(a.toLowerCase()) ?? 0n;
  }

  private credit(a: string, v: bigint): void {
    this.balances.set(a.toLowerCase(), this.bal(a) + v);
  }

  /** Time passes: the keeper (if on) prepares growing tranches 48 h ahead and delivers what is due. */
  private tick(): void {
    if (!this.keeperOn) return;
    const now = this.now();
    for (const s of this.schedules.values()) {
      if (s.state !== State.Active) continue;
      for (const t of s.tranches) {
        if (t.status !== Status.Pending) continue;
        if (t.staked && t.stage === Stage.Staked && now + PREPARE_LEAD >= t.unlockTime) t.stage = Stage.Unbonding;
        if (now >= t.unlockTime) this.deliver(s, t, 'executed', t.unlockTime + 2);
      }
      this.maybeClose(s);
    }
  }

  private deliver(s: SimSchedule, t: SimTranche, how: DeliveryInfo['how'], at: number): void {
    const pay = t.staked && t.stage !== Stage.Idle ? this.settle(s, t) : t.amount;
    t.status = Status.Delivered;
    this.credit(t.recipient, pay);
    s.deliveries.push({ id: t.id, how, blockTime: at, tx: this.fakeHash(s, t.id, how) });
    if (how === 'executed' && s.tipPool >= s.tip) s.tipPool -= s.tip;
  }

  /** Principal plus 90 % of the rewards the illustration assumes. */
  private settle(s: SimSchedule, t: SimTranche): bigint {
    t.stage = Stage.Liquid;
    const g = growth(true, s.t0, t.unlockTime);
    t.payout = BigInt(Math.round(Number(t.amount / 10n ** 12n) * g)) * 10n ** 12n;
    return t.payout;
  }

  private maybeClose(s: SimSchedule): void {
    if (s.tranches.every((t) => t.status !== Status.Pending && t.status !== Status.Claimable)) {
      s.state = State.Closed;
      if (s.tipPool > 0n) this.credit(s.creator, s.tipPool);
      s.tipPool = 0n;
    }
  }

  private fakeHash(s: SimSchedule, id: number, how: string): Hex {
    let h = 0n;
    for (const c of `${s.address}${id}${how}`) h = (h * 131n + BigInt(c.charCodeAt(0))) % (1n << 256n);
    return ('0x' + h.toString(16).padStart(64, '0')) as Hex;
  }

  private fakeAddress(n: number): Address {
    return ('0x5c0de' + n.toString(16).padStart(35, '0')) as Address;
  }

  // ------------------------------------------------------------------ Adapter: session
  async chainNow(): Promise<number> {
    this.tick();
    return this.now();
  }

  async limits(): Promise<Limits> {
    return { now: this.now(), minWindow: 60, maxWindow: 30 * DAY, maxTip: MON, stakeLead: PREPARE_LEAD + DAY };
  }

  account(): Address | null {
    return this.acct;
  }

  onAccountChange(cb: (a: Address | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async connect(): Promise<Address> {
    this.actAs(DEMO_USER);
    return DEMO_USER;
  }

  async balance(a: Address): Promise<bigint> {
    return this.bal(a);
  }

  // ------------------------------------------------------------------ Adapter: writes
  private spend(who: Address | null, v: bigint): void {
    if (!who) throw new UserError('Connect your wallet first.');
    if (this.bal(who) < v) throw new UserError('There is not enough balance for this plus the network fee.');
    this.credit(who, -v);
  }

  private find(vault: Address): SimSchedule {
    const s = this.schedules.get(vault.toLowerCase());
    if (!s) throw new UserError('This is not a Kindred schedule from this network.');
    return s;
  }

  async create(plan: Plan): Promise<{ vault: Address; tx: Hex }> {
    this.tick();
    const lim = await this.limits();
    const issues = problems(plan, lim);
    if (issues.length) throw new UserError(issues[0]!);
    const value = requiredValue(plan);
    this.spend(this.acct, value + GAS_COST);
    const now = this.now();
    const address = this.fakeAddress(this.counter++);
    const s: SimSchedule = {
      address, creator: this.acct!, staked: plan.grow, revocable: plan.revocable, state: State.Active,
      fundingDeadline: now + plan.fundingWindow, cancelRequestedAt: 0, tip: plan.tip,
      tipPool: plan.tip * tipSlots(plan.grow) * BigInt(plan.tranches.length), fallback: (plan.fallback ?? this.acct!) as Address, deliveries: [], t0: now,
      tranches: plan.tranches.map((t, id) => {
        const staked = plan.grow && t.unlockTime >= now + PREPARE_LEAD + DAY;
        return { id, recipient: t.recipient, kind: 0, amount: t.amount, unlockTime: t.unlockTime, status: Status.Pending, stage: staked ? Stage.Staked : Stage.Idle, payout: 0n, staked };
      }),
    };
    this.schedules.set(address.toLowerCase(), s);
    this.save();
    return { vault: address, tx: this.fakeHash(s, 0, 'create') };
  }

  async claim(vault: Address, id: number, key?: Hex): Promise<Hex> {
    this.tick();
    const s = this.find(vault);
    const t = s.tranches[id];
    if (!t) throw new UserError('Nothing to do yet. It may already be done, or not due.');
    const who = (key ? privateKeyToAccount(key).address : this.acct) as Address | null;
    if (!who || who.toLowerCase() !== t.recipient.toLowerCase()) throw new UserError('Only the recipient can do that.');
    if (t.status !== Status.Pending && t.status !== Status.Claimable) throw new UserError('Nothing to do yet. It may already be done, or not due.');
    if (this.now() < t.unlockTime) throw new UserError('It has not unlocked yet.');
    this.spend(who, GAS_COST);
    if (t.staked && t.stage === Stage.Staked) {
      t.stage = Stage.Unbonding; // unlocked but never prepared: this call starts unbonding
    } else {
      this.deliver(s, t, 'claimed', this.now());
      this.maybeClose(s);
    }
    this.save();
    return this.fakeHash(s, id, 'claim');
  }

  async setRecipient(vault: Address, id: number, to: Address, key?: Hex): Promise<Hex> {
    this.tick();
    const s = this.find(vault);
    const t = s.tranches[id];
    const who = (key ? privateKeyToAccount(key).address : this.acct) as Address | null;
    if (!t || !who || who.toLowerCase() !== t.recipient.toLowerCase()) throw new UserError('Only the recipient can do that.');
    if (t.status !== Status.Pending && t.status !== Status.Claimable) throw new UserError('Nothing to do yet. It may already be done, or not due.');
    this.spend(who, GAS_COST);
    t.recipient = to;
    this.save();
    return this.fakeHash(s, id, 'recipient');
  }

  private creatorOnly(vault: Address): SimSchedule {
    this.tick();
    const s = this.find(vault);
    if (!this.acct || this.acct.toLowerCase() !== s.creator.toLowerCase()) throw new UserError('Only the person who created this schedule can do that.');
    return s;
  }

  async requestCancel(vault: Address): Promise<Hex> {
    const s = this.creatorOnly(vault);
    if (!s.revocable) throw new UserError('This schedule was made permanent, so it cannot be cancelled.');
    if (s.cancelRequestedAt) throw new UserError('A cancellation is already waiting out its 7 days.');
    this.spend(this.acct, GAS_COST);
    s.cancelRequestedAt = this.now();
    this.save();
    return this.fakeHash(s, 0, 'cancel');
  }

  async abortCancel(vault: Address): Promise<Hex> {
    const s = this.creatorOnly(vault);
    if (!s.cancelRequestedAt) throw new UserError('There is no cancellation waiting.');
    this.spend(this.acct, GAS_COST);
    s.cancelRequestedAt = 0;
    this.save();
    return this.fakeHash(s, 0, 'abort');
  }

  async finalizeCancel(vault: Address): Promise<Hex> {
    const s = this.creatorOnly(vault);
    if (!s.cancelRequestedAt) throw new UserError('There is no cancellation waiting.');
    if (this.now() < s.cancelRequestedAt + CANCEL_DELAY) throw new UserError('The 7-day wait is not over yet.');
    const now = this.now();
    const open = s.tranches.filter((t) => t.status === Status.Pending && now < t.unlockTime);
    if (open.length === 0) throw new UserError('Everything left has already unlocked, so there is nothing to cancel.');
    this.spend(this.acct, GAS_COST);
    for (const t of open) {
      t.status = Status.Cancelled;
      this.credit(s.creator, t.amount);
      s.tipPool -= s.tipPool >= s.tip * tipSlots(s.staked) ? s.tip * tipSlots(s.staked) : s.tipPool;
    }
    s.cancelRequestedAt = 0;
    this.maybeClose(s);
    this.save();
    return this.fakeHash(s, 0, 'finalize');
  }

  async fundGas(to: Address, amount: bigint): Promise<Hex> {
    this.spend(this.acct, amount + GAS_COST);
    this.credit(to, amount);
    this.save();
    return ('0x' + 'ab'.repeat(32)) as Hex;
  }

  async moveAll(key: Hex, to: Address): Promise<Hex> {
    const from = privateKeyToAccount(key).address;
    const b = this.bal(from);
    if (b <= GAS_COST) throw new UserError('There is nothing to move yet.');
    this.credit(from, -b);
    this.credit(to, b - GAS_COST);
    this.save();
    return ('0x' + 'cd'.repeat(32)) as Hex;
  }

  // ------------------------------------------------------------------ Adapter: reads
  async get(vault: Address): Promise<ScheduleView> {
    this.tick();
    const s = this.find(vault);
    const now = this.now();
    let position: ScheduleView['position'];
    if (s.staked) {
      let stake = 0n, total = 0;
      for (const t of s.tranches) {
        if (t.staked && (t.stage === Stage.Staked || t.stage === Stage.Unbonding) && t.status === Status.Pending) {
          stake += t.amount;
          total += Number(t.amount / 10n ** 12n) * (growth(true, s.t0, now) - 1);
        }
      }
      position = { stake, rewards: BigInt(Math.max(0, Math.round(total / 0.9))) * 10n ** 12n };
    }
    return {
      address: s.address, creator: s.creator, staked: s.staked, revocable: s.revocable, state: s.state, fundingDeadline: s.fundingDeadline,
      cancelRequestedAt: s.cancelRequestedAt, tipPool: s.tipPool, fallback: s.fallback, position, chainNow: now,
      tranches: s.tranches.map(({ staked: _staked, ...t }) => ({ ...t })), deliveries: s.deliveries.map((d) => ({ ...d })),
    };
  }

  async listByCreator(creator: Address): Promise<Address[]> {
    return [...this.schedules.values()].filter((s) => s.creator.toLowerCase() === creator.toLowerCase()).map((s) => s.address).reverse();
  }
}
