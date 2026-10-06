import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, PublicClient, WalletClient } from 'viem';
import { Account, privateKeyToAccount } from 'viem/accounts';
import { Backoff } from '../src/backoff.js';
import { defaultGasFloors, KeeperConfig } from '../src/config.js';
import { Discovery } from '../src/discovery.js';
import { Executor } from '../src/executor.js';
import { Keeper } from '../src/keeper.js';
import { silentLogger } from '../src/log.js';
import { Metrics } from '../src/metrics.js';
import { Address } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'contracts', 'out');
export const DAY = 86_400n;
export const STAKING = '0x0000000000000000000000000000000000001000' as Address;
export const VAL = 7n;

// anvil's well-known development keys (public; never use on a real network)
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
] as const;
export const accounts = KEYS.map((k) => privateKeyToAccount(k));
export const [deployer, creator, alice, bob, keeperA, keeperB, feeSink] = accounts as [Account, Account, Account, Account, Account, Account, Account];

export function artifact(file: string, name: string): { abi: never; bytecode: `0x${string}`; deployed: `0x${string}` } {
  const path = join(OUT, `${file}.sol`, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}: run \`forge build\` in contracts/ first`);
  const j = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: j.abi as never, bytecode: j.bytecode.object, deployed: j.deployedBytecode.object };
}

export interface Chain {
  pub: PublicClient;
  chain: ReturnType<typeof defineChain>;
  url: string;
  wallet(a: Account): WalletClient;
  stop(): Promise<void>;
}

export async function startAnvil(port: number): Promise<Chain> {
  const home = process.env.HOME ?? '';
  const bin = process.env.ANVIL_BIN ?? (existsSync(join(home, '.foundry', 'bin', 'anvil')) ? join(home, '.foundry', 'bin', 'anvil') : 'anvil');
  const proc: ChildProcess = spawn(bin, ['--port', String(port), '--silent', '--accounts', '10', '--gas-limit', '100000000'], { stdio: 'ignore' });
  let spawnError: Error | undefined;
  proc.on('error', (e) => (spawnError = e));
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
      if (spawnError) throw new Error(`cannot run anvil (${bin}): ${spawnError.message}. Install Foundry or set ANVIL_BIN.`);
      if (i === 99) throw new Error('anvil did not start');
    }
  }
  return {
    pub,
    chain,
    url,
    wallet: (a) => createWalletClient({ account: a, chain, transport: http(url) }),
    stop: async () => {
      proc.kill('SIGKILL');
    },
  };
}

type Rpc = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
export const rpc = (c: Chain, method: string, params: unknown[] = []) => (c.pub as unknown as Rpc).request({ method, params });

export async function chainTime(c: Chain): Promise<bigint> {
  return (await c.pub.getBlock({ blockTag: 'latest' })).timestamp;
}

/** Mines a block whose timestamp is exactly `ts` (so a tranche can be due at its exact unlock second). */
export async function warpTo(c: Chain, ts: bigint): Promise<void> {
  const now = await chainTime(c);
  if (ts <= now) return;
  await rpc(c, 'evm_setNextBlockTimestamp', ['0x' + ts.toString(16)]);
  await rpc(c, 'evm_mine');
}

export interface World {
  c: Chain;
  factory: Address;
  factoryAbi: never;
  vaultAbi: never;
  stakedAbi: never;
  mockAbi: never;
  send(from: Account, to: Address, abi: never, fn: string, args?: unknown[], value?: bigint): Promise<`0x${string}`>;
  read<T>(to: Address, abi: never, fn: string, args?: unknown[]): Promise<T>;
  createSchedule(o: CreateOpts): Promise<Address>;
  balance(a: Address): Promise<bigint>;
}

export interface TrancheOpt {
  recipient: Address;
  amount: bigint;
  unlockIn: bigint; // seconds from chain time now
}

export interface CreateOpts {
  tranches: TrancheOpt[];
  staked?: boolean;
  tip?: bigint;
  fundNow?: boolean;
  fundingWindow?: bigint;
  fallback?: Address;
}

let saltCounter = 1n;

export async function deployWorld(c: Chain): Promise<World> {
  const factoryArt = artifact('ScheduleFactory', 'ScheduleFactory');
  const mock = artifact('MockStaking', 'MockStaking');
  const vault = artifact('ScheduleVault', 'ScheduleVault');
  const staked = artifact('StakedScheduleVault', 'StakedScheduleVault');

  const wDeployer = c.wallet(deployer);
  const hash = await wDeployer.deployContract({
    abi: factoryArt.abi,
    bytecode: factoryArt.bytecode,
    args: [60n, 30n * DAY, parseEther('1'), 48n * 3600n, feeSink.address, [VAL]],
    account: deployer,
    chain: c.chain,
  } as never);
  const factory = (await c.pub.waitForTransactionReceipt({ hash })).contractAddress as Address;

  // The staking precompile lives at 0x1000: install the test double there.
  await rpc(c, 'anvil_setCode', [STAKING, mock.deployed]);

  const w: World = {
    c,
    factory,
    factoryAbi: factoryArt.abi,
    vaultAbi: vault.abi,
    stakedAbi: staked.abi,
    mockAbi: mock.abi,
    async send(from, to, abi, fn, args = [], value = 0n) {
      const h = await c.wallet(from).writeContract({ address: to, abi, functionName: fn, args, value, account: from, chain: c.chain } as never);
      const r = await c.pub.waitForTransactionReceipt({ hash: h });
      if (r.status !== 'success') throw new Error(`${fn} reverted`);
      return h;
    },
    read: <T>(to: Address, abi: never, fn: string, args: unknown[] = []) => c.pub.readContract({ address: to, abi, functionName: fn, args } as never) as Promise<T>,
    async balance(a) {
      return c.pub.getBalance({ address: a });
    },
    async createSchedule(o) {
      const now = await chainTime(c);
      const tip = o.tip ?? 0n;
      const fundNow = o.fundNow ?? true;
      const tranches = o.tranches.map((t) => ({
        recipient: t.recipient,
        kind: 0,
        token: '0x0000000000000000000000000000000000000000' as Address,
        amountOrId: t.amount,
        unlockTime: now + t.unlockIn,
      }));
      const slots = o.staked ? 3n : 1n;
      const reserve = tip * slots * BigInt(tranches.length);
      const value = fundNow ? reserve + tranches.reduce((s, t) => s + t.amountOrId, 0n) : reserve;
      const params = {
        fallbackRecipient: o.fallback ?? ('0x0000000000000000000000000000000000000000' as Address),
        revocable: false,
        fundingWindow: o.fundingWindow ?? 60n,
        tipPerExecution: tip,
        salt: ('0x' + (saltCounter++).toString(16).padStart(64, '0')) as `0x${string}`,
        validatorId: o.staked ? VAL : 0n,
      };
      const h = await w.send(creator, factory, factoryArt.abi, 'create', [params, tranches, fundNow], value);
      const rcpt = await c.pub.getTransactionReceipt({ hash: h });
      // ScheduleCreated(vault indexed, ...): topic[1] is the vault
      const log = rcpt.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase());
      return ('0x' + (log!.topics[1] as string).slice(26)) as Address;
    },
  };
  await w.send(deployer, STAKING, mock.abi, 'addValidator', [VAL]);
  await w.send(deployer, STAKING, mock.abi, 'setEpoch', [100n]);
  return w;
}

export interface TestKeeper {
  keeper: Keeper;
  metrics: Metrics;
  discovery: Discovery;
  backoff: Backoff;
  cfg: KeeperConfig;
}

export function makeKeeper(w: World, account: Account, o: Partial<KeeperConfig> & { backoff?: Backoff; pubOverride?: PublicClient; walletOverride?: WalletClient } = {}): TestKeeper {
  const cfg: KeeperConfig = {
    rpcUrl: w.c.url,
    chainId: 31337,
    factory: w.factory,
    privateKey: '0x00',
    fromBlock: 0n,
    pollMs: 1000,
    logChunk: 500n,
    confirmations: 0n,
    statusPort: 0,
    maxActionsPerTick: 10,
    sweep: false,
    onTimeSeconds: 60,
    minBalanceWei: 10n ** 17n,
    claimableRetryMs: 3_600_000,
    receiptTimeoutMs: 30_000,
    gasPadPercent: 130n,
    gas: defaultGasFloors,
    logLevel: 'error',
    ...o,
  } as KeeperConfig;
  const pub = o.pubOverride ?? w.c.pub;
  const wallet = o.walletOverride ?? w.c.wallet(account);
  const discovery = new Discovery(pub, w.factory, cfg.fromBlock, cfg.logChunk, cfg.confirmations, cfg.stateFile);
  const metrics = new Metrics(cfg.onTimeSeconds, cfg.metricsFile);
  const backoff = o.backoff ?? new Backoff(1, 5);
  const keeper = new Keeper(pub, new Executor(pub, wallet, account, w.c.chain, cfg), discovery, metrics, backoff, cfg, silentLogger, account.address);
  return { keeper, metrics, discovery, backoff, cfg };
}
