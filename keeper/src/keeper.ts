import type { PublicClient } from 'viem';
import { Backoff } from './backoff.js';
import { KeeperConfig } from './config.js';
import { Discovery } from './discovery.js';
import { Executor } from './executor.js';
import { Logger } from './log.js';
import { Metrics } from './metrics.js';
import { planAll } from './planner.js';
import { readVault } from './snapshot.js';
import { Action, actionKey, State, VaultSnap } from './types.js';

export interface TickReport {
  ok: boolean;
  blockNumber: bigint;
  chainTime: bigint;
  tracked: number;
  open: number;
  planned: number;
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  newVaults: number;
  errors: string[];
}

export interface KeeperStatus {
  startedAt: number;
  ticks: number;
  lastTickAt: number | null;
  lastOkTickAt: number | null;
  lastReport: TickReport | null;
  lastError: string | null;
  address: string;
  balanceWei: string | null;
  lowBalance: boolean;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class Keeper {
  readonly status: KeeperStatus;

  constructor(
    private readonly pub: PublicClient,
    private readonly executor: Executor,
    private readonly discovery: Discovery,
    private readonly metrics: Metrics,
    private readonly backoff: Backoff,
    private readonly cfg: KeeperConfig,
    private readonly log: Logger,
    readonly address: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.status = {
      startedAt: clock(),
      ticks: 0,
      lastTickAt: null,
      lastOkTickAt: null,
      lastReport: null,
      lastError: null,
      address,
      balanceWei: null,
      lowBalance: false,
    };
  }

  /**
   * One pass: discover, read, plan, act. Never throws: a failed tick is reported and the next
   * tick starts from scratch (all state is re-derived from the chain).
   */
  async tick(): Promise<TickReport> {
    const report: TickReport = {
      ok: false, blockNumber: 0n, chainTime: 0n, tracked: 0, open: 0, planned: 0,
      attempted: 0, sent: 0, skipped: 0, failed: 0, newVaults: 0, errors: [],
    };
    this.status.ticks++;
    this.status.lastTickAt = this.clock();
    try {
      const block = await this.pub.getBlock({ blockTag: 'latest' });
      report.blockNumber = block.number;
      report.chainTime = block.timestamp;

      report.newVaults = await this.discovery.scan(block.number);
      report.tracked = this.discovery.vaults.size;
      const open = this.discovery.open();
      report.open = open.length;

      const snaps = (
        await mapLimit(open, 8, async (v): Promise<VaultSnap | null> => {
          try {
            return await readVault(this.pub, v.address, v.staked);
          } catch (e) {
            report.errors.push(`read ${v.address}: ${(e as Error).message.split('\n')[0]}`);
            return null;
          }
        })
      ).filter((s): s is VaultSnap => s !== null);

      for (const s of snaps) if (s.state === State.Closed) this.discovery.markClosed(s.address);

      const plan = planAll(snaps, block.timestamp, { sweep: this.cfg.sweep });
      report.planned = plan.length;

      for (const action of plan) {
        if (report.attempted >= this.cfg.maxActionsPerTick) break;
        const key = actionKey(action);
        if (!this.backoff.canTry(key, this.clock())) continue;
        report.attempted++;
        await this.act(action, key, report);
      }
      this.discovery.save();
      await this.refreshBalance();
      report.ok = true;
      this.status.lastOkTickAt = this.clock();
      this.status.lastError = report.errors.length ? report.errors[0] ?? null : null;
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0] ?? 'unknown error';
      report.errors.push(msg);
      this.status.lastError = msg;
      this.log.error('tick failed', { error: msg });
    }
    this.status.lastReport = report;
    return report;
  }

  private async act(a: Action, key: string, report: TickReport): Promise<void> {
    const label = { action: a.kind, vault: a.vault, id: a.id };
    const out = await this.executor.run(a);

    if (out.kind === 'skipped') {
      report.skipped++; // not an error and not worth backing off: re-checked next tick
      this.log.debug('skipped', { ...label, reason: out.reason });
      return;
    }
    if (out.kind === 'failed') {
      report.failed++;
      const delay = this.backoff.fail(key, this.clock());
      this.metrics.record({ kind: 'error', vault: a.vault, id: a.id, detail: `${a.kind}: ${out.error}` });
      this.log.warn('action failed', { ...label, error: out.error, retryInMs: delay });
      return;
    }

    report.sent++;
    this.backoff.succeed(key);
    const lateness = a.id === undefined ? undefined : Number(out.blockTime - a.dueAt);
    switch (out.effect) {
      case 'delivered':
        this.metrics.record({ kind: 'delivered', vault: a.vault, id: a.id, lateness, tx: out.hash });
        this.log.info('delivered', { ...label, latenessSeconds: lateness, tx: out.hash });
        break;
      case 'pushFailed':
        // Recoverable by design: the recipient can claim. Try again later, but not every tick.
        this.backoff.defer(key, this.clock() + this.cfg.claimableRetryMs);
        this.metrics.record({ kind: 'pushFailed', vault: a.vault, id: a.id, tx: out.hash });
        this.log.warn('push failed; tranche is claimable', { ...label, tx: out.hash });
        break;
      case 'progressed':
      case 'prepared':
        this.metrics.record({ kind: 'prepared', vault: a.vault, id: a.id, tx: out.hash });
        this.log.info('unbonding started', { ...label, tx: out.hash });
        break;
      default:
        this.metrics.record({ kind: out.effect === 'noop' ? 'error' : (out.effect as 'staked'), vault: a.vault, id: a.id, tx: out.hash });
        this.log.info(out.effect, { ...label, tx: out.hash });
    }
  }

  private async refreshBalance(): Promise<void> {
    try {
      const bal = await this.pub.getBalance({ address: this.address as `0x${string}` });
      this.status.balanceWei = bal.toString();
      const low = bal < this.cfg.minBalanceWei;
      if (low && !this.status.lowBalance) this.log.warn('keeper balance is low', { balanceWei: bal });
      this.status.lowBalance = low;
    } catch {
      /* informational only */
    }
  }
}
