import type { Address } from '../lib/format.js';
import type { Limits, Plan } from '../lib/plan.js';

/** Mirrors ScheduleTypes.sol / StakedScheduleVault.Stage. */
export const Kind = { Native: 0, ERC20: 1, ERC721: 2 } as const;
export const Status = { Pending: 0, Delivered: 1, Claimable: 2, Swept: 3, Cancelled: 4 } as const;
export const State = { AwaitingFunds: 0, Active: 1, Closed: 2 } as const;
export const Stage = { Idle: 0, Staked: 1, Unbonding: 2, Liquid: 3 } as const;

export interface TrancheView {
  id: number;
  recipient: Address;
  kind: number;
  amount: bigint;
  unlockTime: number;
  status: number;
  /** Staked schedules only. */
  stage: number;
  /** Final amount once a staked tranche is settled (principal + 90 % of rewards). */
  payout: bigint;
}

export interface DeliveryInfo {
  id: number;
  how: 'executed' | 'claimed' | 'swept';
  blockTime: number;
  tx: `0x${string}`;
}

export interface ScheduleView {
  address: Address;
  creator: Address;
  staked: boolean;
  revocable: boolean;
  state: number;
  fundingDeadline: number;
  /** 0 = no cancellation pending. */
  cancelRequestedAt: number;
  tipPool: bigint;
  fallback: Address;
  tranches: TrancheView[];
  deliveries: DeliveryInfo[];
  /** Staked schedules: principal currently in Monad staking and rewards not yet harvested. */
  position?: { stake: bigint; rewards: bigint };
  /** Chain time when this was read. */
  chainNow: number;
}

export interface Adapter {
  readonly mode: 'live' | 'sim';
  chainNow(): Promise<number>;
  limits(): Promise<Limits>;

  /** Connected account, if any. */
  account(): Address | null;
  onAccountChange(cb: (a: Address | null) => void): () => void;
  connect(): Promise<Address>;
  balance(addr: Address): Promise<bigint>;

  create(plan: Plan): Promise<{ vault: Address; tx: `0x${string}` }>;
  get(vault: Address): Promise<ScheduleView>;
  listByCreator(creator: Address): Promise<Address[]>;

  /** `key`: act as a claim-link key instead of the connected wallet (the recipient has no wallet yet). */
  claim(vault: Address, id: number, key?: `0x${string}`): Promise<`0x${string}`>;
  setRecipient(vault: Address, id: number, to: Address, key?: `0x${string}`): Promise<`0x${string}`>;
  requestCancel(vault: Address): Promise<`0x${string}`>;
  abortCancel(vault: Address): Promise<`0x${string}`>;
  finalizeCancel(vault: Address): Promise<`0x${string}`>;

  /** Creator sends a small amount of gas to a claim-link address so its holder can claim without any keeper. */
  fundGas(to: Address, amount: bigint): Promise<`0x${string}`>;
  /** Moves everything a claim-link key holds (minus the network fee) to `to`. */
  moveAll(key: `0x${string}`, to: Address): Promise<`0x${string}`>;

  /** Simulation only: jump the clock (and let the simulated keeper act). */
  travelTo?(unixSeconds: number): Promise<void>;
}

export const isOpen = (s: number): boolean => s === Status.Pending || s === Status.Claimable;
