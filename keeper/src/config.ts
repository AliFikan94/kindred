import { Address } from './types.js';
import { Level } from './log.js';

export interface GasFloors {
  /** Gas limits are floors, never caps: the contract refuses to run a push with less than it needs. */
  executeIdle: bigint;
  executeStaked: bigint;
  prepare: bigint;
  stakeBase: bigint;
  stakePerTranche: bigint;
  activate: bigint;
  refund: bigint;
  sweepIdle: bigint;
  sweepStaked: bigint;
}

export interface KeeperConfig {
  rpcUrl: string;
  chainId: number;
  factory: Address;
  privateKey: `0x${string}`;
  fromBlock: bigint;
  pollMs: number;
  logChunk: bigint;
  confirmations: bigint;
  stateFile?: string;
  metricsFile?: string;
  statusPort: number;
  maxActionsPerTick: number;
  sweep: boolean;
  onTimeSeconds: number;
  minBalanceWei: bigint;
  claimableRetryMs: number;
  receiptTimeoutMs: number;
  gasPadPercent: bigint;
  gas: GasFloors;
  logLevel: Level;
}

export const defaultGasFloors: GasFloors = {
  executeIdle: 600_000n,
  executeStaked: 1_400_000n,
  prepare: 1_400_000n,
  stakeBase: 1_000_000n,
  stakePerTranche: 400_000n,
  activate: 600_000n,
  refund: 300_000n,
  sweepIdle: 1_000_000n,
  sweepStaked: 1_500_000n,
};

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`missing required env var ${k}`);
  return v;
}

const big = (v: string | undefined, d: bigint): bigint => (v === undefined || v === '' ? d : BigInt(v));
const num = (v: string | undefined, d: number): number => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const pk = need(env, 'KEEPER_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('KEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  const factory = need(env, 'FACTORY');
  if (!/^0x[0-9a-fA-F]{40}$/.test(factory)) throw new Error('FACTORY must be an address');
  return {
    rpcUrl: need(env, 'RPC_URL'),
    chainId: Number(need(env, 'CHAIN_ID')),
    factory: factory as Address,
    privateKey: pk as `0x${string}`,
    fromBlock: big(env.FROM_BLOCK, 0n),
    pollMs: num(env.POLL_MS, 5_000),
    logChunk: big(env.LOG_CHUNK, 2_000n),
    confirmations: big(env.CONFIRMATIONS, 0n),
    stateFile: env.STATE_FILE || undefined,
    metricsFile: env.METRICS_FILE || undefined,
    statusPort: num(env.STATUS_PORT, 0),
    maxActionsPerTick: num(env.MAX_ACTIONS_PER_TICK, 10),
    sweep: env.SWEEP === 'true',
    onTimeSeconds: num(env.ON_TIME_SECONDS, 60),
    minBalanceWei: big(env.MIN_BALANCE_WEI, 10n ** 17n),
    claimableRetryMs: num(env.CLAIMABLE_RETRY_MS, 3_600_000),
    receiptTimeoutMs: num(env.RECEIPT_TIMEOUT_MS, 60_000),
    gasPadPercent: big(env.GAS_PAD_PERCENT, 130n),
    gas: {
      executeIdle: big(env.GAS_EXECUTE_IDLE, defaultGasFloors.executeIdle),
      executeStaked: big(env.GAS_EXECUTE_STAKED, defaultGasFloors.executeStaked),
      prepare: big(env.GAS_PREPARE, defaultGasFloors.prepare),
      stakeBase: big(env.GAS_STAKE_BASE, defaultGasFloors.stakeBase),
      stakePerTranche: big(env.GAS_STAKE_PER_TRANCHE, defaultGasFloors.stakePerTranche),
      activate: big(env.GAS_ACTIVATE, defaultGasFloors.activate),
      refund: big(env.GAS_REFUND, defaultGasFloors.refund),
      sweepIdle: big(env.GAS_SWEEP_IDLE, defaultGasFloors.sweepIdle),
      sweepStaked: big(env.GAS_SWEEP_STAKED, defaultGasFloors.sweepStaked),
    },
    logLevel: (env.LOG_LEVEL as Level) || 'info',
  };
}
