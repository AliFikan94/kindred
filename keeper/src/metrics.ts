import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type MetricKind =
  | 'delivered' // a tranche reached its recipient
  | 'pushFailed' // delivery was attempted but the recipient/token refused: the tranche is now claimable
  | 'prepared'
  | 'staked'
  | 'activated'
  | 'refunded'
  | 'swept'
  | 'error';

export interface MetricEvent {
  t: number; // wall-clock ms
  kind: MetricKind;
  vault?: string;
  id?: number;
  /** Seconds between the tranche's unlock time and the block that delivered it. */
  lateness?: number;
  tx?: string;
  detail?: string;
}

export interface Summary {
  counts: Record<string, number>;
  deliveries: number;
  onTimeRate: number | null;
  latenessSeconds: { p50: number; p95: number; max: number } | null;
}

const pct = (sorted: number[], p: number): number => {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] ?? 0;
};

/** Records what the keeper did; the one number that matters is delivery lateness. */
export class Metrics {
  private readonly events: MetricEvent[] = [];
  private readonly lateness: number[] = [];
  private readonly counts: Record<string, number> = {};

  constructor(
    private readonly onTimeSeconds = 60,
    private readonly file?: string,
    private readonly maxRecent = 200,
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  record(e: Omit<MetricEvent, 't'> & { t?: number }): void {
    const ev: MetricEvent = { t: e.t ?? Date.now(), ...e };
    this.counts[ev.kind] = (this.counts[ev.kind] ?? 0) + 1;
    if (ev.kind === 'delivered' && ev.lateness !== undefined) this.lateness.push(ev.lateness);
    this.events.push(ev);
    if (this.events.length > this.maxRecent) this.events.shift();
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify(ev) + '\n');
      } catch {
        /* metrics must never take the keeper down */
      }
    }
  }

  summary(): Summary {
    const sorted = [...this.lateness].sort((a, b) => a - b);
    const n = sorted.length;
    return {
      counts: { ...this.counts },
      deliveries: n,
      onTimeRate: n === 0 ? null : sorted.filter((x) => x <= this.onTimeSeconds).length / n,
      latenessSeconds: n === 0 ? null : { p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted[n - 1] ?? 0 },
    };
  }

  recent(): MetricEvent[] {
    return [...this.events];
  }
}
