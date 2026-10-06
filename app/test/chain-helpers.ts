import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AppConfig, readConfig } from '../src/chain/config.js';
import { Eip1193 } from '../src/chain/live.js';
import { Address } from '../src/lib/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', '..', 'contracts', 'out');
export const DAY = 86_400n;
export const STAKING = '0x0000000000000000000000000000000000001000' as Address;
export const VAL = 7n;

// anvil's public development keys: never use on a real network
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
] as const;
export const accts = KEYS.map((k) => privateKeyToAccount(k));
export const [deployer, creator, alice, bob, keeper, feeSink] = accts as [typeof accts[0], typeof accts[0], typeof accts[0], typeof accts[0], typeof accts[0], typeof accts[0]];

export function artifact(file: string, name: string) {
  const path = join(OUT, `${file}.sol`, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}: run \`forge build\` in contracts/ first`);
  const j = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: j.abi as never, bytecode: j.bytecode.object as `0x${string}`, deployed: j.deployedBytecode.object as `0x${string}` };
}

export interface Node {
  url: string;
  pub: PublicClient;
  chain: ReturnType<typeof defineChain>;
  rpc(method: string, params?: unknown[]): Promise<unknown>;
  stop(): void;
  warpTo(ts: number): Promise<void>;
}

export async function startAnvil(port: number): Promise<Node> {
  const home = process.env.HOME ?? '';
  const bin = process.env.ANVIL_BIN ?? (existsSync(join(home, '.foundry', 'bin', 'anvil')) ? join(home, '.foundry', 'bin', 'anvil') : 'anvil');
  const proc: ChildProcess = spawn(bin, ['--port', String(port), '--silent', '--gas-limit', '100000000'], { stdio: 'ignore' });
  let spawnError: Error | undefined;
  proc.on('error', (e) => (spawnError = e));
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try { await pub.getBlockNumber({ cacheTime: 0 }); break; } catch {
      await new Promise((r) => setTimeout(r, 100));
      if (spawnError) throw new Error(`cannot run anvil (${bin}): ${spawnError.message}`);
      if (i === 99) throw new Error('anvil did not start');
    }
  }
  const rpc = (method: string, params: unknown[] = []) => (pub as unknown as { request(a: object): Promise<unknown> }).request({ method, params });
  return {
    url, pub, chain, rpc, stop: () => { proc.kill('SIGKILL'); },
    async warpTo(ts: number) {
      const now = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
      if (ts <= now) return;
      await rpc('evm_setNextBlockTimestamp', ['0x' + ts.toString(16)]);
      await rpc('evm_mine');
    },
  };
}

export interface Deployed {
  factory: Address;
  cfg: AppConfig;
  mock: { abi: never };
  vaultAbi: never;
  stakedAbi: never;
}

export async function deploy(node: Node): Promise<Deployed> {
  const f = artifact('ScheduleFactory', 'ScheduleFactory');
  const m = artifact('MockStaking', 'MockStaking');
  const w = createWalletClient({ account: deployer, chain: node.chain, transport: http(node.url) });
  const hash = await w.deployContract({
    abi: f.abi, bytecode: f.bytecode, args: [60n, 30n * DAY, 10n ** 18n, 48n * 3600n, feeSink.address, [VAL]],
  } as never);
  const rcpt = await node.pub.waitForTransactionReceipt({ hash });
  await node.rpc('anvil_setCode', [STAKING, m.deployed]);
  for (const [fn, args] of [['addValidator', [VAL]], ['setEpoch', [100n]]] as const) {
    const h = await w.writeContract({ address: STAKING, abi: m.abi, functionName: fn, args } as never);
    await node.pub.waitForTransactionReceipt({ hash: h });
  }
  const factory = rcpt.contractAddress as Address;
  const cfg = readConfig({
    VITE_FACTORY: factory, VITE_CHAIN_ID: '31337', VITE_RPC_URL: node.url, VITE_VALIDATOR_ID: String(VAL),
    VITE_FACTORY_BLOCK: rcpt.blockNumber.toString(), VITE_TIP_WEI: '10000000000000000', VITE_CHAIN_NAME: 'anvil',
  });
  return { factory, cfg, mock: { abi: m.abi }, vaultAbi: artifact('ScheduleVault', 'ScheduleVault').abi, stakedAbi: artifact('StakedScheduleVault', 'StakedScheduleVault').abi };
}

/** A wallet stand-in: an EIP-1193 provider for one anvil dev account (anvil signs for unlocked dev accounts). */
export function anvilProvider(node: Node, account: Address, opts: { chainId?: number } = {}): Eip1193 & { calls: string[] } {
  let connected = false;
  const calls: string[] = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_requestAccounts') { connected = true; return [account]; }
      if (method === 'eth_accounts') return connected ? [account] : [];
      if (method === 'eth_chainId') return '0x' + (opts.chainId ?? 31337).toString(16);
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        const tx = { ...(params as [Record<string, unknown>])[0], from: account };
        return node.rpc('eth_sendTransaction', [tx]);
      }
      return node.rpc(method, (params as unknown[]) ?? []);
    },
  };
}
