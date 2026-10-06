import type { Address } from '../lib/format.js';

export interface AppConfig {
  /** 'live' needs a deployed factory; without one the app runs entirely in the browser (simulation). */
  mode: 'live' | 'sim';
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer?: string;
  factory?: Address;
  /** Block the factory was deployed at (log scans start here). */
  factoryBlock: bigint;
  /** Allowlisted validator used for "grow"; 0 disables growing. */
  validatorId: bigint;
  /** Native tip per keeper step (wei). */
  tip: bigint;
  keeperUrl?: string;
  /** Shows the "arrives in N minutes" option so a real execution can be shown live. */
  demo: boolean;
  currency: string;
}

type Env = Record<string, string | undefined>;

const addr = /^0x[0-9a-fA-F]{40}$/;

export function readConfig(env: Env): AppConfig {
  const factory = env.VITE_FACTORY && addr.test(env.VITE_FACTORY) ? (env.VITE_FACTORY as Address) : undefined;
  const wantsSim = env.VITE_MODE === 'sim';
  return {
    mode: factory && !wantsSim ? 'live' : 'sim',
    chainId: Number(env.VITE_CHAIN_ID ?? 0),
    chainName: env.VITE_CHAIN_NAME ?? 'Monad',
    rpcUrl: env.VITE_RPC_URL ?? '',
    explorer: env.VITE_EXPLORER || undefined,
    factory,
    factoryBlock: BigInt(env.VITE_FACTORY_BLOCK ?? 0),
    validatorId: BigInt(env.VITE_VALIDATOR_ID ?? 0),
    tip: BigInt(env.VITE_TIP_WEI ?? '10000000000000000'), // 0.01 MON
    keeperUrl: env.VITE_KEEPER_URL || undefined,
    demo: env.VITE_DEMO === '1',
    currency: env.VITE_CURRENCY ?? 'MON',
  };
}
