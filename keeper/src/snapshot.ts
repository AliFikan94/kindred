import type { PublicClient } from 'viem';
import vaultAbi from './abi/ScheduleVault.json' with { type: 'json' };
import stakedAbi from './abi/StakedScheduleVault.json' with { type: 'json' };
import { Address, Kind, State, TrancheSnap, VaultSnap } from './types.js';

type RawTranche = { unlockTime: bigint; kind: number; status: number };

/** Reads everything the planner needs about one vault in a handful of parallel calls. */
export async function readVault(client: PublicClient, address: Address, staked: boolean): Promise<VaultSnap> {
  const abi = (staked ? stakedAbi : vaultAbi) as never;
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  const [state, fundingDeadline] = await Promise.all([read<number>('state'), read<bigint>('fundingDeadline')]);
  if (state === State.Closed) {
    return { address, staked, state, fundingDeadline, prepareLead: 0n, tranches: [] };
  }

  const raw = await read<RawTranche[]>('tranches');
  let prepareLead = 0n;
  let stages: number[] = raw.map(() => 0);
  if (staked) {
    [prepareLead, stages] = await Promise.all([
      read<bigint>('PREPARE_LEAD'),
      Promise.all(raw.map((t, i) => (t.kind === Kind.Native ? read<number>('stage', [BigInt(i)]) : Promise.resolve(0)))),
    ]);
  }

  const tranches: TrancheSnap[] = raw.map((t, i) => ({
    id: i,
    unlockTime: BigInt(t.unlockTime),
    kind: Number(t.kind),
    status: Number(t.status),
    stage: Number(stages[i] ?? 0),
  }));
  return { address, staked, state: Number(state), fundingDeadline: BigInt(fundingDeadline), prepareLead, tranches };
}
