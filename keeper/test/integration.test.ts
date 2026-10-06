import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, parseEther, PublicClient } from 'viem';
import { Backoff } from '../src/backoff.js';
import { startStatusServer } from '../src/status.js';
import { Stage, State, Status } from '../src/types.js';
import {
  accounts, alice, artifact, bob, chainTime, Chain, creator, DAY, deployer, deployWorld, feeSink, keeperA, keeperB,
  makeKeeper, rpc, STAKING, startAnvil, VAL, warpTo, World,
} from './helpers.js';

let c: Chain;
let w: World;

beforeAll(async () => {
  c = await startAnvil(20_000 + Math.floor(Math.random() * 20_000));
  w = await deployWorld(c);
});
afterAll(async () => {
  await c?.stop();
});

const startBlock = async () => (await c.pub.getBlockNumber({ cacheTime: 0 })) + 1n; // viem caches block numbers by default
const mock = (fn: string, args: unknown[] = [], value = 0n) => w.send(deployer, STAKING, w.mockAbi, fn, args, value);
const vaultState = async (v: `0x${string}`) => Number(await w.read<number>(v, w.vaultAbi, 'state'));
const status = async (v: `0x${string}`, id = 0) => Number((await w.read<{ status: number }>(v, w.vaultAbi, 'tranche', [BigInt(id)])).status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('idle schedules', () => {
  it('does nothing before the unlock second, delivers at it, and tips the keeper', async () => {
    const from = await startBlock();
    const vault = await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('3'), unlockIn: 10n * DAY }], tip: parseEther('0.01') });
    const k = makeKeeper(w, keeperA, { fromBlock: from });
    const unlock = (await chainTime(c)) + 10n * DAY - 5n; // creation block time ~ now
    const t = await w.read<{ unlockTime: bigint }>(vault, w.vaultAbi, 'tranche', [0n]);

    const before = await k.keeper.tick();
    expect(before.sent).toBe(0);
    expect(before.planned).toBe(0);

    await warpTo(c, t.unlockTime - 1n);
    expect((await k.keeper.tick()).sent).toBe(0);

    const aliceBefore = await w.balance(alice.address);
    const keeperBefore = await w.balance(keeperA.address);
    await warpTo(c, t.unlockTime);
    const r = await k.keeper.tick();
    expect(r.sent).toBe(1);
    expect((await w.balance(alice.address)) - aliceBefore).toBe(parseEther('3'));
    expect(await w.balance(keeperA.address)).toBeGreaterThan(keeperBefore); // tip beat the gas
    expect(await vaultState(vault)).toBe(State.Closed);
    const s = k.metrics.summary();
    expect(s.deliveries).toBe(1);
    expect(s.latenessSeconds!.max).toBeLessThanOrEqual(5);
    expect(s.onTimeRate).toBe(1);
    void unlock;
  });

  it('measures lateness honestly: a keeper that wakes up late reports it', async () => {
    const from = await startBlock();
    await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 100n }] });
    const k = makeKeeper(w, keeperA, { fromBlock: from });
    const unlock = (await chainTime(c)) + 100n;
    await warpTo(c, unlock + 1000n); // the keeper was away for ~17 minutes
    await k.keeper.tick();
    const s = k.metrics.summary();
    expect(s.latenessSeconds!.max).toBeGreaterThanOrEqual(1000);
    expect(s.latenessSeconds!.max).toBeLessThan(1100);
    expect(s.onTimeRate).toBe(0);
  });

  it('backs off an action whose transaction fails, then retries it and succeeds', async () => {
    const from = await startBlock();
    const vault = await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 100n }] });
    const real = c.wallet(keeperA);
    let failNext = 1;
    const flakyWallet = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'writeContract' && failNext > 0) return async () => { failNext--; throw new Error('mempool rejected'); };
        return Reflect.get(target, prop, recv);
      },
    });
    const k = makeKeeper(w, keeperA, { fromBlock: from, walletOverride: flakyWallet, backoff: new Backoff(150, 300) });
    await warpTo(c, (await chainTime(c)) + 200n);

    const r1 = await k.keeper.tick();
    expect([r1.sent, r1.failed]).toEqual([0, 1]);
    expect(k.metrics.summary().counts.error).toBe(1);
    const r2 = await k.keeper.tick(); // still inside the backoff window
    expect(r2.attempted).toBe(0);
    await sleep(200);
    const r3 = await k.keeper.tick();
    expect(r3.sent).toBe(1);
    expect(await vaultState(vault)).toBe(State.Closed);
  });

  it('delivers each tranche of several schedules when it comes due, and stops watching closed vaults', async () => {
    const from = await startBlock();
    const v1 = await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 1000n }] });
    const v2 = await w.createSchedule({
      tranches: [
        { recipient: alice.address, amount: parseEther('1'), unlockIn: 2000n },
        { recipient: bob.address, amount: parseEther('2'), unlockIn: 4000n },
      ],
    });
    const k = makeKeeper(w, keeperA, { fromBlock: from });
    const now = await chainTime(c);

    await warpTo(c, now + 1500n);
    expect((await k.keeper.tick()).sent).toBe(1);
    expect(await vaultState(v1)).toBe(State.Closed);

    await warpTo(c, now + 2500n);
    expect((await k.keeper.tick()).sent).toBe(1);
    expect(await status(v2, 0)).toBe(Status.Delivered);
    expect(await status(v2, 1)).toBe(Status.Pending);

    const bobBefore = await w.balance(bob.address);
    await warpTo(c, now + 4500n);
    expect((await k.keeper.tick()).sent).toBe(1);
    expect((await w.balance(bob.address)) - bobBefore).toBe(parseEther('2'));

    await k.keeper.tick(); // learns both vaults are closed...
    expect(k.discovery.open().length).toBe(0);
    const r = await k.keeper.tick(); // ...and no longer reads them
    expect(r.open).toBe(0);
    expect(r.planned).toBe(0);
  });

  it('serves the most overdue first when a tick is capped', async () => {
    const from = await startBlock();
    const vs: `0x${string}`[] = [];
    for (const secs of [1000n, 2000n, 3000n, 4000n]) {
      vs.push(await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: secs }] }));
    }
    const k = makeKeeper(w, keeperA, { fromBlock: from, maxActionsPerTick: 2 });
    await warpTo(c, (await chainTime(c)) + 5000n);

    expect((await k.keeper.tick()).sent).toBe(2);
    expect(await Promise.all(vs.map(vaultState))).toEqual([State.Closed, State.Closed, State.Active, State.Active]);
    expect((await k.keeper.tick()).sent).toBe(2);
    expect(await Promise.all(vs.map(vaultState))).toEqual([State.Closed, State.Closed, State.Closed, State.Closed]);
  });

  it('two keepers racing on the same tranche deliver exactly once', async () => {
    const from = await startBlock();
    const vault = await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('5'), unlockIn: 100n }], tip: parseEther('0.01') });
    const a = makeKeeper(w, keeperA, { fromBlock: from });
    const b = makeKeeper(w, keeperB, { fromBlock: from });
    await warpTo(c, (await chainTime(c)) + 200n);
    const aliceBefore = await w.balance(alice.address);

    const [ra, rb] = await Promise.all([a.keeper.tick(), b.keeper.tick()]);
    expect((await w.balance(alice.address)) - aliceBefore).toBe(parseEther('5'));
    expect(await vaultState(vault)).toBe(State.Closed);
    expect(a.metrics.summary().deliveries + b.metrics.summary().deliveries).toBe(1);
    expect(ra.ok && rb.ok).toBe(true);
  });

  it('records a failed push as recoverable, retries only after the retry delay, and delivers once fixed', async () => {
    const from = await startBlock();
    const rej = artifact('Mocks', 'Rejector');
    const h = await c.wallet(deployer).deployContract({ abi: rej.abi, bytecode: rej.bytecode, account: deployer, chain: c.chain } as never);
    const rejector = (await c.pub.waitForTransactionReceipt({ hash: h })).contractAddress!;
    const vault = await w.createSchedule({ tranches: [{ recipient: rejector, amount: parseEther('2'), unlockIn: 100n }] });
    const k = makeKeeper(w, keeperA, { fromBlock: from, claimableRetryMs: 150 });
    await warpTo(c, (await chainTime(c)) + 200n);

    expect((await k.keeper.tick()).sent).toBe(1);
    expect(await status(vault)).toBe(Status.Claimable);
    expect(k.metrics.summary().counts.pushFailed).toBe(1);
    expect(k.metrics.summary().deliveries).toBe(0);

    const immediate = await k.keeper.tick(); // inside the retry delay: must not hammer the chain
    expect(immediate.attempted).toBe(0);

    // the recipient rotates to a working address (they hold the rejecting contract's authority)
    await rpc(c, 'anvil_impersonateAccount', [rejector]);
    await rpc(c, 'anvil_setBalance', [rejector, '0x56BC75E2D63100000']);
    const data = encodeFunctionData({ abi: w.vaultAbi, functionName: 'setRecipient', args: [0n, bob.address] } as never);
    const tx = (await rpc(c, 'eth_sendTransaction', [{ from: rejector, to: vault, data }])) as `0x${string}`;
    await c.pub.waitForTransactionReceipt({ hash: tx });

    await sleep(200);
    const bobBefore = await w.balance(bob.address);
    expect((await k.keeper.tick()).sent).toBe(1);
    expect((await w.balance(bob.address)) - bobBefore).toBe(parseEther('2'));
    expect(await vaultState(vault)).toBe(State.Closed);
  });
});

describe('staked schedules', () => {
  const stakedSchedule = (amount = '100', tip = '0.01') =>
    w.createSchedule({ staked: true, tip: parseEther(tip), tranches: [{ recipient: alice.address, amount: parseEther(amount), unlockIn: 10n * DAY }] });

  it('runs the whole lifecycle unattended: prepare 48h ahead, wait for unbonding, deliver principal + 90% of rewards', async () => {
    const from = await startBlock();
    const vault = await stakedSchedule();
    expect(Number(await w.read<number>(vault, w.stakedAbi, 'stage', [0n]))).toBe(Stage.Staked);
    const k = makeKeeper(w, keeperA, { fromBlock: from });
    const unlock = (await w.read<{ unlockTime: bigint }>(vault, w.vaultAbi, 'tranche', [0n])).unlockTime;

    await mock('advance', [1n]); // stake becomes active
    await mock('accrue', [VAL, vault], parseEther('10')); // rewards

    await warpTo(c, unlock - 48n * 3600n - 1n);
    expect((await k.keeper.tick()).sent).toBe(0); // window not open yet

    await warpTo(c, unlock - 48n * 3600n);
    expect((await k.keeper.tick()).sent).toBe(1); // prepare
    expect(Number(await w.read<number>(vault, w.stakedAbi, 'stage', [0n]))).toBe(Stage.Unbonding);

    await warpTo(c, unlock);
    const waiting = await k.keeper.tick(); // due, but the staking epoch has not advanced: nothing to send
    expect(waiting.sent).toBe(0);
    expect(waiting.skipped).toBeGreaterThan(0);
    expect(await status(vault)).toBe(Status.Pending);

    await mock('advance', [2n]); // unbonding completes
    const aliceBefore = await w.balance(alice.address);
    const feeBefore = await w.balance(feeSink.address);
    expect((await k.keeper.tick()).sent).toBe(1);
    expect((await w.balance(alice.address)) - aliceBefore).toBe(parseEther('109'));
    expect((await w.balance(feeSink.address)) - feeBefore).toBe(parseEther('1'));
    expect(await vaultState(vault)).toBe(State.Closed);
    expect(k.metrics.summary().latenessSeconds!.max).toBeLessThanOrEqual(5);
  });

  it('still delivers if the keeper missed the prepare window (worst case: starts unbonding at unlock)', async () => {
    const from = await startBlock();
    const vault = await stakedSchedule('50', '0');
    const k = makeKeeper(w, keeperA, { fromBlock: from });
    const unlock = (await w.read<{ unlockTime: bigint }>(vault, w.vaultAbi, 'tranche', [0n])).unlockTime;
    await mock('advance', [1n]);

    await warpTo(c, unlock + 3600n); // keeper was "down" through the whole window
    expect((await k.keeper.tick()).sent).toBe(1); // execute() starts unbonding
    expect(Number(await w.read<number>(vault, w.stakedAbi, 'stage', [0n]))).toBe(Stage.Unbonding);
    expect(await status(vault)).toBe(Status.Pending);

    await mock('advance', [2n]);
    const aliceBefore = await w.balance(alice.address);
    expect((await k.keeper.tick()).sent).toBe(1);
    expect((await w.balance(alice.address)) - aliceBefore).toBe(parseEther('50'));
  });

  it('activates a funded draft and then stakes it', async () => {
    const from = await startBlock();
    const vault = await w.createSchedule({
      staked: true, fundNow: false, tip: parseEther('0.01'),
      tranches: [{ recipient: alice.address, amount: parseEther('20'), unlockIn: 10n * DAY }],
    });
    const k = makeKeeper(w, keeperA, { fromBlock: from });

    const unfunded = await k.keeper.tick();
    expect(unfunded.sent).toBe(0); // activation simulated, would revert: not sent
    expect(unfunded.skipped).toBe(1);

    // funds arrive by plain transfer (the cross-chain path)
    await c.wallet(creator).sendTransaction({ to: vault, value: parseEther('20'), account: creator, chain: c.chain });
    expect((await k.keeper.tick()).sent).toBe(1); // activate
    expect(await vaultState(vault)).toBe(State.Active);
    expect((await k.keeper.tick()).sent).toBe(1); // stakeAll
    expect(Number(await w.read<number>(vault, w.stakedAbi, 'stage', [0n]))).toBe(Stage.Staked);
    expect(await w.balance(STAKING)).toBeGreaterThanOrEqual(parseEther('20'));
    expect((await k.keeper.tick()).sent).toBe(0); // nothing left to do
  });
});

describe('staking refusals', () => {
  it('does not send a pointless stake transaction when the precompile would refuse every delegation', async () => {
    const from = await startBlock();
    const vault = await w.createSchedule({
      staked: true, fundNow: false, tip: parseEther('0.01'),
      tranches: [{ recipient: alice.address, amount: parseEther('10'), unlockIn: 10n * DAY }],
    });
    await c.wallet(creator).sendTransaction({ to: vault, value: parseEther('10'), account: creator, chain: c.chain });
    const k = makeKeeper(w, keeperA, { fromBlock: from });
    await k.keeper.tick(); // activate
    expect(await vaultState(vault)).toBe(State.Active);

    await mock('setFailDelegate', [true]);
    try {
      const refused = await k.keeper.tick();
      expect(refused.sent).toBe(0); // simulated: would stake nothing
      expect(Number(await w.read<number>(vault, w.stakedAbi, 'stage', [0n]))).toBe(Stage.Idle);
    } finally {
      await mock('setFailDelegate', [false]);
    }
    expect((await k.keeper.tick()).sent).toBe(1); // now it works
    expect(Number(await w.read<number>(vault, w.stakedAbi, 'stage', [0n]))).toBe(Stage.Staked);
  });
});

describe('funding windows', () => {
  it('refunds a schedule that was never funded once its window has passed', async () => {
    const from = await startBlock();
    const vault = await w.createSchedule({ fundNow: false, fundingWindow: 60n, tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: DAY }] });
    const k = makeKeeper(w, keeperA, { fromBlock: from });
    expect((await k.keeper.tick()).sent).toBe(0);
    await warpTo(c, (await chainTime(c)) + 61n);
    expect((await k.keeper.tick()).sent).toBe(1);
    expect(await vaultState(vault)).toBe(State.Closed);
  });
});

describe('statelessness and resilience', () => {
  it('recovers from its state file after a restart, and from a corrupt one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-'));
    const stateFile = join(dir, 'state.json');
    const from = await startBlock();
    await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 5000n }] });
    const first = makeKeeper(w, keeperA, { fromBlock: from, stateFile });
    expect((await first.keeper.tick()).newVaults).toBe(1);

    const second = makeKeeper(w, keeperA, { fromBlock: 0n, stateFile }); // cursor comes from the file, not fromBlock
    expect(second.discovery.vaults.size).toBe(1);
    expect((await second.keeper.tick()).newVaults).toBe(0);

    writeFileSync(stateFile, '{ not json');
    const third = makeKeeper(w, keeperA, { fromBlock: from, stateFile });
    expect(third.discovery.vaults.size).toBe(0);
    expect((await third.keeper.tick()).newVaults).toBe(1); // rebuilt from the chain
  });

  it('does not skip blocks when a log scan fails half-way: the cursor only advances past chunks it has read', async () => {
    const from = await startBlock();
    const vaults: string[] = [];
    for (let i = 0; i < 3; i++) {
      vaults.push(await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 10n * DAY }] }));
    }
    let calls = 0;
    const flaky = new Proxy(c.pub, {
      get(target, prop, recv) {
        if (prop === 'getLogs') {
          return async (a: unknown) => {
            if (++calls === 2) throw new Error('log range rejected');
            return (Reflect.get(target, prop, recv) as (x: unknown) => Promise<unknown>).call(target, a);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as PublicClient;
    const k = makeKeeper(w, keeperA, { fromBlock: from, logChunk: 1n, pubOverride: flaky });

    const r1 = await k.keeper.tick();
    expect(r1.ok).toBe(false);
    expect(k.discovery.vaults.size).toBeLessThan(3); // got some, not all
    const r2 = await k.keeper.tick();
    expect(r2.ok).toBe(true);
    expect(k.discovery.vaults.size).toBe(3); // nothing was skipped
  });

  it('survives RPC failures and keeps working: a failed tick reports, the next one recovers', async () => {
    const from = await startBlock();
    const vault = await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 100n }] });
    let failures = 2;
    const flaky = new Proxy(c.pub, {
      get(target, prop, recv) {
        if (prop === 'getBlock' && failures > 0) return async () => { failures--; throw new Error('rpc down'); };
        return Reflect.get(target, prop, recv);
      },
    }) as PublicClient;
    const k = makeKeeper(w, keeperA, { fromBlock: from, pubOverride: flaky });
    await warpTo(c, (await chainTime(c)) + 200n);

    const r1 = await k.keeper.tick();
    const r2 = await k.keeper.tick();
    expect([r1.ok, r2.ok]).toEqual([false, false]);
    expect(r1.errors[0]).toMatch(/rpc down/);
    expect(await vaultState(vault)).toBe(State.Active);
    const r3 = await k.keeper.tick();
    expect(r3.ok).toBe(true);
    expect(await vaultState(vault)).toBe(State.Closed);
  });

  it('one unreadable vault does not stop the others', async () => {
    const from = await startBlock();
    const bad = await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 100n }] });
    const good = await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 100n }] });
    const broken = new Proxy(c.pub, {
      get(target, prop, recv) {
        if (prop === 'readContract') {
          return async (a: { address: string }) => {
            if (a.address.toLowerCase() === bad.toLowerCase()) throw new Error('bad vault');
            return (Reflect.get(target, prop, recv) as (x: unknown) => Promise<unknown>).call(target, a);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as PublicClient;
    const k = makeKeeper(w, keeperA, { fromBlock: from, pubOverride: broken });
    await warpTo(c, (await chainTime(c)) + 200n);
    const r = await k.keeper.tick();
    expect(r.ok).toBe(true);
    expect(r.errors.some((e) => e.includes('bad vault'))).toBe(true);
    expect(await vaultState(good)).toBe(State.Closed);
    expect(await vaultState(bad)).toBe(State.Active);
  });

  it('exposes status and health over HTTP', async () => {
    const from = await startBlock();
    await w.createSchedule({ tranches: [{ recipient: alice.address, amount: parseEther('1'), unlockIn: 100n }] });
    const k = makeKeeper(w, keeperA, { fromBlock: from });
    await warpTo(c, (await chainTime(c)) + 200n);
    await k.keeper.tick();

    const port = 41_000 + Math.floor(Math.random() * 5000);
    let now = Date.now();
    const server = startStatusServer(port, k.keeper, k.metrics, 1000, () => now);
    await sleep(100);
    try {
      const s = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
      expect(s.healthy).toBe(true);
      expect(s.reliability.deliveries).toBe(1);
      expect(s.address.toLowerCase()).toBe(keeperA.address.toLowerCase());
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      now += 10 * 60_000; // no successful tick for ten minutes
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
    } finally {
      server.close();
    }
  });
});

void accounts;
void Backoff;
