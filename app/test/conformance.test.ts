import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LiveAdapter } from '../src/chain/live.js';
import { SimAdapter } from '../src/chain/sim.js';
import { Adapter, Stage, State, Status } from '../src/chain/types.js';
import { Address } from '../src/lib/format.js';
import { familyTranches, Plan } from '../src/lib/plan.js';
import { alice, anvilProvider, bob, creator, deploy, Deployed, keeper, Node, startAnvil, DAY } from './chain-helpers.js';

/**
 * The same scenarios, run against the simulator and against the real contracts on a real node.
 * The simulator is only allowed to exist because this suite keeps it honest.
 */
interface Backend {
  creator(): Promise<Adapter>;
  /** An adapter with no wallet at all (a gift-link holder's device). */
  anonymous(): Adapter;
  stranger(): Promise<Adapter>;
  warpTo(ts: number): Promise<void>;
  /** Lets the keeper do its job for a vault (a no-op for the simulator, which has its own keeper). */
  keeperDeliver(vault: Address): Promise<void>;
  keeperOff(): void;
  RECIPIENT: Address;
  OTHER: Address;
}

const MON = 10n ** 18n;
const D = Number(DAY);
let node: Node;
let d: Deployed;

beforeAll(async () => {
  node = await startAnvil(50_000 + Math.floor(Math.random() * 10_000));
  d = await deploy(node);
});
afterAll(() => node?.stop());

const liveBackend = (): Backend => ({
  RECIPIENT: alice.address,
  OTHER: bob.address,
  async creator() {
    const a = new LiveAdapter(d.cfg, anvilProvider(node, creator.address));
    await a.connect();
    return a;
  },
  anonymous: () => new LiveAdapter(d.cfg, null),
  async stranger() {
    const a = new LiveAdapter(d.cfg, anvilProvider(node, bob.address));
    await a.connect();
    return a;
  },
  warpTo: (ts) => node.warpTo(ts),
  async keeperDeliver(vault) {
    const w = createWalletClient({ account: keeper, chain: node.chain, transport: http(node.url) });
    const n = Number(await node.pub.readContract({ address: vault, abi: d.vaultAbi, functionName: 'trancheCount' } as never));
    for (let i = 0; i < n; i++) {
      try {
        const h = await w.writeContract({ address: vault, abi: d.vaultAbi, functionName: 'execute', args: [BigInt(i)] } as never);
        await node.pub.waitForTransactionReceipt({ hash: h });
      } catch { /* not due / already done: exactly what a real keeper skips */ }
    }
  },
  keeperOff() { /* the live keeper only acts when asked */ },
});

const simBackend = (): Backend => {
  const sim = new SimAdapter(() => Math.floor(Date.now() / 1000), null);
  return {
    RECIPIENT: alice.address,
    OTHER: bob.address,
    async creator() { await sim.connect(); return sim; },
    anonymous: () => { sim.actAs(null); return sim; },
    async stranger() { sim.actAs(bob.address); return sim; },
    warpTo: (ts) => sim.travelTo(ts),
    async keeperDeliver() { /* built in */ },
    keeperOff: () => sim.setKeeper(false),
  };
};

describe.each([
  ['simulator', simBackend],
  ['real contracts', liveBackend],
])('%s', (_name, makeBackend) => {
  const mk = async (b: Backend, a: Adapter, o: Partial<Plan> & { days?: number; to?: Address } = {}): Promise<Plan> => ({
    preset: 'family', label: 'Maya', tranches: familyTranches(o.to ?? b.RECIPIENT, 3n * MON, (await a.chainNow()) + (o.days ?? 30) * D),
    grow: false, revocable: true, tip: parseEther('0.01'), fundingWindow: 60, ...o,
  });

  it('delivers on the day, exactly, and closes the schedule', async () => {
    const b = makeBackend();
    const a = await b.creator();
    const p = await mk(b, a);
    const { vault } = await a.create(p);
    const unlock = p.tranches[0]!.unlockTime;
    const before = await a.balance(b.RECIPIENT);

    await b.warpTo(unlock - 1);
    await b.keeperDeliver(vault);
    expect((await a.get(vault)).tranches[0]!.status).toBe(Status.Pending);

    await b.warpTo(unlock);
    await b.keeperDeliver(vault);
    const v = await a.get(vault);
    expect(v.tranches[0]!.status).toBe(Status.Delivered);
    expect(v.state).toBe(State.Closed);
    expect(v.deliveries[0]!.how).toBe('executed');
    expect(v.deliveries[0]!.blockTime - unlock).toBeLessThanOrEqual(5);
    expect((await a.balance(b.RECIPIENT)) - before).toBe(3n * MON);
  });

  it('refuses early claims and impostors with the same sentences', async () => {
    const b = makeBackend();
    const a = await b.creator();
    const { vault } = await a.create(await mk(b, a));
    const s = await b.stranger();
    await expect(s.claim(vault, 0)).rejects.toThrow(/Only the recipient/);
    await expect(s.requestCancel(vault)).rejects.toThrow(/Only the person who created/);
  });

  it('rejects an invalid plan the same way', async () => {
    const b = makeBackend();
    const a = await b.creator();
    await expect(a.create(await mk(b, a, { days: -2 }))).rejects.toThrow(/future/);
  });

  it('cancel: permanent refuses; revocable needs 7 days, then returns the funds', async () => {
    const b = makeBackend();
    const a = await b.creator();
    const perm = await a.create(await mk(b, a, { revocable: false }));
    await expect(a.requestCancel(perm.vault)).rejects.toThrow(/permanent/);

    const { vault } = await a.create(await mk(b, a, { days: 40 }));
    await a.requestCancel(vault);
    const at = (await a.get(vault)).cancelRequestedAt;
    expect(at).toBeGreaterThan(0);
    await expect(a.finalizeCancel(vault)).rejects.toThrow(/7-day/);
    await b.warpTo(at + 7 * D);
    await a.finalizeCancel(vault);
    const v = await a.get(vault);
    expect(v.tranches[0]!.status).toBe(Status.Cancelled);
    expect(v.state).toBe(State.Closed);
  });

  it('growing: staked at creation, permanent, three tip slots reserved', async () => {
    const b = makeBackend();
    const a = await b.creator();
    const { vault } = await a.create(await mk(b, a, { days: 30, grow: true, revocable: false }));
    const v = await a.get(vault);
    expect([v.staked, v.revocable]).toEqual([true, false]);
    expect(v.tranches[0]!.stage).toBe(Stage.Staked);
    expect(v.tipPool).toBe(parseEther('0.03'));
    await expect(a.requestCancel(vault)).rejects.toThrow(/permanent/);
    await expect(a.create(await mk(b, a, { days: 2, grow: true, revocable: false }))).rejects.toThrow(/at least 3 days/);
  });

  it('a gift link works with no wallet and no keeper: gas drip, claim by key, move to a wallet', async () => {
    const b = makeBackend();
    const a = await b.creator();
    const key = generatePrivateKey();
    const addr = privateKeyToAccount(key).address;
    const p = await mk(b, a, { to: addr, days: 20 });
    const { vault } = await a.create(p);
    await a.fundGas(addr, parseEther('0.05'));

    b.keeperOff(); // before the day arrives: nobody is going to deliver this for them
    await b.warpTo(p.tranches[0]!.unlockTime);
    const device = b.anonymous();
    await device.claim(vault, 0, key);
    expect((await device.get(vault)).deliveries[0]!.how).toBe('claimed');

    const before = await device.balance(b.OTHER);
    await device.moveAll(key, b.OTHER);
    expect((await device.balance(b.OTHER)) - before).toBeGreaterThan(3n * MON);
  });
});
