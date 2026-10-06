export type Address = `0x${string}`;

/** Mirrors ScheduleTypes.sol. */
export const Kind = { Native: 0, ERC20: 1, ERC721: 2 } as const;
export const Status = { Pending: 0, Delivered: 1, Claimable: 2, Swept: 3, Cancelled: 4 } as const;
export const State = { AwaitingFunds: 0, Active: 1, Closed: 2 } as const;
/** Mirrors StakedScheduleVault.Stage. */
export const Stage = { Idle: 0, Staked: 1, Unbonding: 2, Liquid: 3 } as const;

export interface TrancheSnap {
  id: number;
  unlockTime: bigint;
  kind: number;
  status: number;
  /** Only for staked vaults, only meaningful for native tranches. */
  stage: number;
}

export interface VaultSnap {
  address: Address;
  staked: boolean;
  state: number;
  fundingDeadline: bigint;
  /** Seconds before unlock when unbonding may start (staked vaults only, else 0n). */
  prepareLead: bigint;
  tranches: TrancheSnap[];
}

export type ActionKind = 'activate' | 'refund' | 'stakeAll' | 'prepare' | 'execute' | 'sweep';

export interface Action {
  kind: ActionKind;
  vault: Address;
  /** Tranche id for prepare / execute / sweep. */
  id?: number;
  /** Unix time this action became (or becomes) due; used to serve the most overdue first. */
  dueAt: bigint;
  /** True when this is a retry of a tranche whose earlier push failed (status Claimable). */
  retry?: boolean;
  /** Whether the vault is a staked one (decides gas floors). */
  staked: boolean;
  /** Number of tranches in the vault (stakeAll gas scales with it). */
  trancheCount: number;
}

export const actionKey = (a: Pick<Action, 'kind' | 'vault' | 'id'>): string =>
  `${a.kind}:${a.vault.toLowerCase()}:${a.id ?? '*'}`;
