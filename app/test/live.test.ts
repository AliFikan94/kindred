import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletClient, http, parseEther } from 'viem';
import { LiveAdapter } from '../src/chain/live.js';
import { Stage, State, Status } from '../src/chain/types.js';
import { UserError } from '../src/lib/errors.js';
import { familyTranches, dropTranches, Plan, requiredValue } from '../src/lib/plan.js';
import { alice, anvilProvider, artifact, bob, creator, deploy, Deployed, keeper, Node, startAnvil, STAKING, VAL, DAY, deployer } from './chain-helpers.js';

let node: Node;
let d: Deployed;
const MON = 10n ** 18n;
const D = Number(DAY);

beforeAll(async () => {
  node = await startAnvil(30_000 + Math.floor(Math.random() * 20_000));
  d = await deploy(node);
});
afterAll(() => node?.stop());

const adapterFor = async (acct: typeof creator, connect = true) => {
  const provider = anvilProvider(node, acct.address);
  const a = new LiveAdapter(d.cfg, provider);
  if (connect) await a.connect();
  return { a, provider };
};
const now = async () => Number((await node.pub.getBlock({ blockTag: 'latest' })).timestamp);
const plan = async (o: Partial<Plan> & { days?: number } = {}): Promise<Plan> => ({
  preset: 'family', label: 'Maya', tranches: familyTranches(alice.address, 3n * MON, (await now()) + (o.days ?? 10) * D),
  grow: false, revocable: true, tip: parseEther('0.01'), fundingWindow: 60, ...o,
});
const mock = async (fn: string, args: unknown[] = [], value = 0n) => {
  const w = createWalletClient({ account: deployer, chain: node.chain, transport: http(node.url) });
  const h = await w.writeContract({ address: STAKING, abi: d.mock.abi, functionName: fn, args, value } as never);
  await node.pub.waitForTransactionReceipt({ hash: h });
};

describe('session', () => {
  it('reads the factory limits and enables growing only for an allowlisted validator', async () => {
    const { a } = await adapterFor(creator, false);
    const l = await a.limits();
    expect([l.minWindow, l.maxWindow]).toEqual([60, 30 * D]);
    expect(l.maxTip).toBe(MON);
    expect(l.stakeLead).toBe(48 * 3600 + D); // prepare lead + 1 day
    expect(Math.abs(l.now - (await now()))).toBeLessThan(5);

    const noStake = new LiveAdapter({ ...d.cfg, validatorId: 0n }, anvilProvider(node, creator.address));
    expect((await noStake.limits()).stakeLead).toBeNull();
    const wrong = new LiveAdapter({ ...d.cfg, validatorId: 99n }, anvilProvider(node, creator.address));
    expect((await wrong.limits()).stakeLead).toBeNull(); // not on the factory's allowlist
  });

  it('connects, notifies, restores silently, and asks the wallet to switch networks when needed', async () => {
    const provider = anvilProvider(node, creator.address, { chainId: 1 });
    const a = new LiveAdapter(d.cfg, provider);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.account()).toBeNull(); // not connected yet: nothing was prompted
    let seen: string | null = null;
    a.onAccountChange((x) => (seen = x));
    await a.connect();
    expect(a.account()).toBe(creator.address);
    expect(seen).toBe(creator.address);
    expect(provider.calls).toContain('wallet_switchEthereumChain');
  });

  it('explains a missing wallet instead of failing obscurely', async () => {
    const a = new LiveAdapter(d.cfg, null);
    await expect(a.connect()).rejects.toThrow(/No wallet found/);
    await expect(a.create(await plan())).rejects.toThrow(/Connect your wallet/);
  });
});

describe('create + read', () => {
  it('creates a schedule and reads it back exactly', async () => {
    const { a } = await adapterFor(creator);
    const p = await plan({ label: 'Maya' });
    const before = await a.balance(creator.address);
    const { vault } = await a.create(p);
    const v = await a.get(vault);

    expect(v.creator).toBe(creator.address);
    expect([v.state, v.staked, v.revocable]).toEqual([State.Active, false, true]);
    expect(v.tranches).toHaveLength(1);
    expect(v.tranches[0]).toMatchObject({ recipient: alice.address, amount: 3n * MON, unlockTime: p.tranches[0]!.unlockTime, status: Status.Pending });
    expect(v.tipPool).toBe(parseEther('0.01'));
    expect(before - (await a.balance(creator.address))).toBeGreaterThanOrEqual(requiredValue(p)); // paid exactly the value (+ gas)
    expect(await node.pub.getBalance({ address: vault })).toBe(requiredValue(p));
  });

  it('creates a multi-recipient drop and a monthly-style schedule', async () => {
    const { a } = await adapterFor(creator);
    const t = await now();
    const p = await plan({ preset: 'drop', tranches: dropTranches([alice.address, bob.address], 2n * MON, t + 10 * D) });
    const { vault } = await a.create(p);
    const v = await a.get(vault);
    expect(v.tranches.map((x) => x.recipient)).toEqual([alice.address, bob.address]);
    expect(v.tipPool).toBe(parseEther('0.02'));
  });

  it('lists a creator\'s schedules newest first and keeps other creators out', async () => {
    const { a } = await adapterFor(creator);
    const one = (await a.create(await plan())).vault;
    const two = (await a.create(await plan())).vault;
    const other = (await adapterFor(bob)).a;
    const theirs = (await other.create(await plan())).vault;
    const mine = await a.listByCreator(creator.address);
    expect(mine.slice(0, 2)).toEqual([two, one]);
    expect(mine).not.toContain(theirs);
    expect(await a.listByCreator(bob.address)).toContain(theirs);
  });
});

describe('guards before the wallet is ever asked', () => {
  it('refuses a plan the contract would reject, with a sentence, and sends nothing', async () => {
    const { a, provider } = await adapterFor(creator);
    const bad = await plan({ days: -1 });
    await expect(a.create(bad)).rejects.toThrow(/future/);
    expect(provider.calls).not.toContain('eth_sendTransaction');
  });

  it('checks the balance first', async () => {
    const { a, provider } = await adapterFor(bob);
    await node.rpc('anvil_setBalance', [bob.address, '0x' + parseEther('1').toString(16)]);
    const rich = await plan({ tranches: familyTranches(alice.address, 50n * MON, (await now()) + 10 * D) });
    await expect(a.create(rich)).rejects.toThrow(/does not have enough/);
    expect(provider.calls).not.toContain('eth_sendTransaction');
    await node.rpc('anvil_setBalance', [bob.address, '0x' + parseEther('10000').toString(16)]);
  });

  it('turns contract errors into sentences', async () => {
    const { a } = await adapterFor(alice);
    const { vault } = await (await adapterFor(creator)).a.create(await plan());
    await expect(a.claim(vault, 0)).rejects.toThrow(/not unlocked/i);
    const stranger = (await adapterFor(bob)).a;
    await expect(stranger.requestCancel(vault)).rejects.toThrow(/Only the person who created/);
  });
});

describe('trust: only schedules from this factory', () => {
  it('rejects an arbitrary address', async () => {
    const { a } = await adapterFor(creator, false);
    await expect(a.get('0x000000000000000000000000000000000000dEaD')).rejects.toThrow(/not a Kindred schedule/i);
  });

  it('rejects a genuine vault that came from a different factory', async () => {
    const other = await deploy(node); // a second, unrelated factory
    const foreign = new LiveAdapter(other.cfg, anvilProvider(node, creator.address));
    await foreign.connect();
    const { vault } = await foreign.create(await plan());
    const ours = new LiveAdapter(d.cfg, anvilProvider(node, creator.address));
    await expect(ours.get(vault)).rejects.toThrow(/not a Kindred schedule/i);
  });
});

describe('delivery and claiming', () => {
  it('shows delivery by a keeper with its real on-chain timing', async () => {
    const { a } = await adapterFor(creator);
    const p = await plan({ days: 10 });
    const { vault } = await a.create(p);
    const unlock = p.tranches[0]!.unlockTime;
    await node.warpTo(unlock);

    const k = createWalletClient({ account: keeper, chain: node.chain, transport: http(node.url) });
    const h = await k.writeContract({ address: vault, abi: d.vaultAbi, functionName: 'execute', args: [0n] } as never);
    await node.pub.waitForTransactionReceipt({ hash: h });

    const v = await a.get(vault);
    expect(v.tranches[0]!.status).toBe(Status.Delivered);
    expect(v.state).toBe(State.Closed);
    expect(v.deliveries).toHaveLength(1);
    expect(v.deliveries[0]).toMatchObject({ id: 0, how: 'executed', tx: h });
    expect(v.deliveries[0]!.blockTime - unlock).toBeLessThanOrEqual(5);
    expect(v.deliveries[0]!.blockTime).toBeGreaterThanOrEqual(unlock);
  });

  it('lets the recipient claim with no keeper at all', async () => {
    const creatorSide = (await adapterFor(creator)).a;
    const p = await plan({ days: 10 });
    const { vault } = await creatorSide.create(p);
    await node.warpTo(p.tranches[0]!.unlockTime);
    const recipient = (await adapterFor(alice)).a;
    const before = await recipient.balance(alice.address);
    await recipient.claim(vault, 0);
    const v = await recipient.get(vault);
    expect(v.deliveries[0]!.how).toBe('claimed');
    expect((await recipient.balance(alice.address)) - before).toBeGreaterThan(2n * MON); // 3 MON minus gas
  });

  it('lets a recipient hand their claim to another address before delivery', async () => {
    const { vault } = await (await adapterFor(creator)).a.create(await plan());
    const r = (await adapterFor(alice)).a;
    await r.setRecipient(vault, 0, bob.address);
    expect((await r.get(vault)).tranches[0]!.recipient).toBe(bob.address);
  });
});

describe('claim links (a recipient with no wallet)', () => {
  it('works end to end with a fresh key: gas drip, claim by the key, move to a real wallet', async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    const key = generatePrivateKey();
    const burner = privateKeyToAccount(key).address;
    const { a } = await adapterFor(creator);
    const p = await plan({ days: 10, tranches: familyTranches(burner, 5n * MON, (await now()) + 10 * D) });
    const { vault } = await a.create(p);
    await a.fundGas(burner, parseEther('0.05'));
    expect(await a.balance(burner)).toBe(parseEther('0.05'));

    await node.warpTo(p.tranches[0]!.unlockTime);
    const holder = new LiveAdapter(d.cfg, null); // the child's device: no wallet at all
    await holder.claim(vault, 0, key); // no keeper involved
    expect((await holder.get(vault)).deliveries[0]!.how).toBe('claimed');
    const held = await holder.balance(burner);
    expect(held).toBeGreaterThan(5n * MON);

    const before = await holder.balance(bob.address);
    await holder.moveAll(key, bob.address);
    expect((await holder.balance(bob.address)) - before).toBeGreaterThan(5n * MON);
    expect(await holder.balance(burner)).toBeLessThan(parseEther('0.001')); // only the fee headroom is left
  });

  it('can hand the claim to a real wallet before the date, using only the key', async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    const key = generatePrivateKey();
    const burner = privateKeyToAccount(key).address;
    const { a } = await adapterFor(creator);
    const { vault } = await a.create(await plan({ tranches: familyTranches(burner, MON, (await now()) + 10 * D) }));
    await a.fundGas(burner, parseEther('0.05'));
    await new LiveAdapter(d.cfg, null).setRecipient(vault, 0, alice.address, key);
    expect((await a.get(vault)).tranches[0]!.recipient).toBe(alice.address);
  });

  it('says so plainly when there is nothing to move', async () => {
    const { generatePrivateKey } = await import('viem/accounts');
    await expect(new LiveAdapter(d.cfg, null).moveAll(generatePrivateKey(), bob.address)).rejects.toThrow(/nothing to move/);
  });

  it('a key without gas cannot claim; the error is understandable', async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    const key = generatePrivateKey();
    const { a } = await adapterFor(creator);
    const p = await plan({ days: 10, tranches: familyTranches(privateKeyToAccount(key).address, MON, (await now()) + 10 * D) });
    const { vault } = await a.create(p);
    await node.warpTo(p.tranches[0]!.unlockTime);
    await expect(new LiveAdapter(d.cfg, null).claim(vault, 0, key)).rejects.toThrow(/enough|fund/i);
  });
});

describe('cancel (revocable schedules)', () => {
  it('request -> abort -> request -> wait 7 days -> finalize refunds the creator', async () => {
    const { a } = await adapterFor(creator);
    const p = await plan({ days: 40 });
    const { vault } = await a.create(p);

    await a.requestCancel(vault);
    expect((await a.get(vault)).cancelRequestedAt).toBeGreaterThan(0);
    await expect(a.finalizeCancel(vault)).rejects.toThrow(/7-day/);
    await a.abortCancel(vault);
    expect((await a.get(vault)).cancelRequestedAt).toBe(0);

    await a.requestCancel(vault);
    const at = (await a.get(vault)).cancelRequestedAt;
    await node.warpTo(at + 7 * D);
    const before = await a.balance(creator.address);
    await a.finalizeCancel(vault);
    const v = await a.get(vault);
    expect(v.tranches[0]!.status).toBe(Status.Cancelled);
    expect(v.state).toBe(State.Closed);
    expect((await a.balance(creator.address)) - before).toBeGreaterThan(3n * MON - parseEther('0.1')); // principal + tip back, minus gas
  });

  it('is refused for a schedule made permanent', async () => {
    const { a } = await adapterFor(creator);
    const { vault } = await a.create(await plan({ revocable: false }));
    await expect(a.requestCancel(vault)).rejects.toThrow(/permanent/);
  });
});

describe('growing (staked) schedules', () => {
  it('stakes at creation, shows the live position, and runs through unbonding to delivery', async () => {
    const { a } = await adapterFor(creator);
    const p = await plan({ days: 10, grow: true, revocable: false, tranches: familyTranches(alice.address, 100n * MON, (await now()) + 10 * D) });
    const { vault } = await a.create(p);
    let v = await a.get(vault);
    expect([v.staked, v.revocable]).toEqual([true, false]);
    expect(v.tranches[0]!.stage).toBe(Stage.Staked);
    expect(v.position!.stake).toBe(0n); // delegated, not yet active (next epoch)
    expect(v.tipPool).toBe(parseEther('0.03')); // three tip slots

    await mock('advance', [1n]);
    await mock('accrue', [VAL, vault], 10n * MON);
    v = await a.get(vault);
    expect(v.position).toEqual({ stake: 100n * MON, rewards: 10n * MON });

    // the keeper's job (prepare 48h ahead), then the epoch passes
    const unlock = p.tranches[0]!.unlockTime;
    await node.warpTo(unlock - 48 * 3600);
    const kw = createWalletClient({ account: keeper, chain: node.chain, transport: http(node.url) });
    await node.pub.waitForTransactionReceipt({ hash: await kw.writeContract({ address: vault, abi: d.stakedAbi, functionName: 'prepare', args: [0n], gas: 3_000_000n } as never) });
    expect((await a.get(vault)).tranches[0]!.stage).toBe(Stage.Unbonding);
    await mock('advance', [2n]);
    await node.warpTo(unlock);

    // the recipient collects: settles the unbonding and is paid principal + 90% of rewards
    const r = (await adapterFor(alice)).a;
    const before = await r.balance(alice.address);
    await r.claim(vault, 0);
    const gain = (await r.balance(alice.address)) - before;
    expect(gain).toBeGreaterThan(109n * MON - parseEther('0.1'));
    expect(gain).toBeLessThanOrEqual(109n * MON);
    expect((await r.get(vault)).tranches[0]!.status).toBe(Status.Delivered);
  });

  it('refuses to grow when the date is too close', async () => {
    const { a } = await adapterFor(creator);
    await expect(a.create(await plan({ days: 2, grow: true, revocable: false }))).rejects.toThrow(/at least 3 days/);
  });
});

void artifact;
