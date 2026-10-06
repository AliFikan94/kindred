import type { Account, Chain, PublicClient, WalletClient } from 'viem';
import vaultAbi from './abi/ScheduleVault.json' with { type: 'json' };
import stakedAbi from './abi/StakedScheduleVault.json' with { type: 'json' };
import { KeeperConfig } from './config.js';
import { Action, Status } from './types.js';

export type Outcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string }
  | { kind: 'sent'; hash: `0x${string}`; blockTime: bigint; effect: Effect };

/** What a confirmed transaction actually achieved (read back from the chain, never assumed). */
export type Effect = 'delivered' | 'pushFailed' | 'progressed' | 'prepared' | 'staked' | 'activated' | 'refunded' | 'swept' | 'noop';

/** Digs the contract's custom error name (or the best available message) out of a viem error. */
export function revertReason(e: unknown): string {
  let cur = e as { cause?: unknown; data?: { errorName?: string }; shortMessage?: string; message?: string } | undefined;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.data?.errorName) return cur.data.errorName;
    cur = cur.cause as typeof cur;
  }
  const top = e as { shortMessage?: string; message?: string };
  return (top.shortMessage ?? top.message ?? String(e)).split('\n')[0] ?? 'unknown';
}

interface Prepared {
  fn: string;
  args: unknown[];
  floor: bigint;
}

export class Executor {
  constructor(
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient,
    private readonly account: Account,
    private readonly chain: Chain,
    private readonly cfg: KeeperConfig,
  ) {}

  private prepare(a: Action): Prepared {
    const g = this.cfg.gas;
    const id = a.id === undefined ? [] : [BigInt(a.id)];
    switch (a.kind) {
      case 'activate':
        return { fn: 'activate', args: [], floor: g.activate };
      case 'refund':
        return { fn: 'refund', args: [], floor: g.refund };
      case 'stakeAll':
        return { fn: 'stakeAll', args: [], floor: g.stakeBase + g.stakePerTranche * BigInt(a.trancheCount) };
      case 'prepare':
        return { fn: 'prepare', args: id, floor: g.prepare };
      case 'execute':
        return { fn: 'execute', args: id, floor: a.staked ? g.executeStaked : g.executeIdle };
      case 'sweep':
        return { fn: 'sweep', args: id, floor: a.staked ? g.sweepStaked : g.sweepIdle };
    }
  }

  async run(a: Action): Promise<Outcome> {
    const abi = (a.staked ? stakedAbi : vaultAbi) as never;
    const p = this.prepare(a);
    const base = { address: a.vault, abi, functionName: p.fn, args: p.args, account: this.account } as never;

    // 1. Dry-run. A revert here means someone else already did it, or it is not time yet: not an error.
    let simulated: unknown;
    try {
      const sim = (await this.pub.simulateContract(base)) as { result: unknown };
      simulated = sim.result;
    } catch (e) {
      return { kind: 'skipped', reason: revertReason(e) };
    }
    if (a.kind === 'stakeAll' && simulated === 0n) return { kind: 'skipped', reason: 'nothing stakeable' };

    // 2. Gas: a floor the contract's own guards need, or the padded estimate if that is higher.
    let gas = p.floor;
    try {
      const est = await this.pub.estimateContractGas(base);
      const padded = (est * this.cfg.gasPadPercent) / 100n;
      if (padded > gas) gas = padded;
    } catch {
      /* the floor alone is a safe choice */
    }

    // 3. Send and confirm.
    try {
      const hash = await this.wallet.writeContract({ ...(base as object), gas, chain: this.chain } as never);
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.cfg.receiptTimeoutMs });
      if (receipt.status !== 'success') return { kind: 'failed', error: `reverted on-chain (${hash})` };
      const block = await this.pub.getBlock({ blockNumber: receipt.blockNumber });
      return { kind: 'sent', hash, blockTime: block.timestamp, effect: await this.effectOf(a) };
    } catch (e) {
      return { kind: 'failed', error: revertReason(e) };
    }
  }

  private async effectOf(a: Action): Promise<Effect> {
    switch (a.kind) {
      case 'activate':
        return 'activated';
      case 'refund':
        return 'refunded';
      case 'stakeAll':
        return 'staked';
      case 'prepare':
        return 'prepared';
      case 'execute':
      case 'sweep': {
        const t = (await this.pub.readContract({
          address: a.vault,
          abi: vaultAbi as never,
          functionName: 'tranche',
          args: [BigInt(a.id ?? 0)],
        } as never)) as { status: number };
        const status = Number(t.status);
        if (status === Status.Delivered) return 'delivered';
        if (status === Status.Swept) return 'swept';
        if (status === Status.Claimable) return 'pushFailed';
        return 'progressed'; // staked tranche: unbonding started, not payable yet
      }
    }
  }
}
