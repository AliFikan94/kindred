import type { PublicClient } from 'viem';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import factoryAbi from './abi/ScheduleFactory.json' with { type: 'json' };
import { Address } from './types.js';

export interface KnownVault {
  address: Address;
  staked: boolean;
  creator: Address;
  block: string;
  closed: boolean;
}

interface Persisted {
  cursor: string;
  vaults: KnownVault[];
}

/**
 * Finds schedules by reading the factory's ScheduleCreated events. Everything is derivable from
 * the chain, so the state file is only a cache: delete it and the keeper rebuilds the same view.
 */
export class Discovery {
  readonly vaults = new Map<string, KnownVault>();
  private cursor: bigint;
  private dirty = false;

  constructor(
    private readonly client: PublicClient,
    private readonly factory: Address,
    fromBlock: bigint,
    private readonly chunk: bigint,
    private readonly confirmations: bigint,
    private readonly stateFile?: string,
  ) {
    this.cursor = fromBlock;
    this.load();
  }

  private load(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const p = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Persisted;
      this.cursor = BigInt(p.cursor);
      for (const v of p.vaults) this.vaults.set(v.address.toLowerCase(), v);
    } catch {
      // A corrupt cache is not fatal: rescan from the configured start block.
    }
  }

  save(): void {
    if (!this.stateFile || !this.dirty) return;
    const p: Persisted = { cursor: this.cursor.toString(), vaults: [...this.vaults.values()] };
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = this.stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(p, null, 2));
    renameSync(tmp, this.stateFile); // atomic: a crash never leaves a half-written file
    this.dirty = false;
  }

  markClosed(address: Address): void {
    const v = this.vaults.get(address.toLowerCase());
    if (v && !v.closed) {
      v.closed = true;
      this.dirty = true;
    }
  }

  open(): KnownVault[] {
    return [...this.vaults.values()].filter((v) => !v.closed);
  }

  /** Scans new blocks up to `latest - confirmations`. Returns the number of newly found vaults. */
  async scan(latest: bigint): Promise<number> {
    const to = latest - this.confirmations;
    if (to < this.cursor) return 0;
    const event = (factoryAbi as Array<{ type: string; name?: string }>).find((x) => x.type === 'event' && x.name === 'ScheduleCreated');
    if (!event) throw new Error('ScheduleCreated missing from the factory ABI; run `npm run abi`');
    let found = 0;
    let from = this.cursor;
    while (from <= to) {
      const end = from + this.chunk - 1n < to ? from + this.chunk - 1n : to;
      const logs = (await this.client.getLogs({ address: this.factory, event, fromBlock: from, toBlock: end } as never)) as unknown as Array<{
        args: { vault: Address; creator: Address; staked: boolean };
        blockNumber: bigint;
      }>;
      for (const l of logs) {
        const key = l.args.vault.toLowerCase();
        if (this.vaults.has(key)) continue;
        this.vaults.set(key, { address: l.args.vault, staked: l.args.staked, creator: l.args.creator, block: l.blockNumber.toString(), closed: false });
        found++;
      }
      from = end + 1n;
      this.cursor = from; // only advances after a successful chunk
      this.dirty = true;
    }
    this.save();
    return found;
  }
}
