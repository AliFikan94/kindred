/** Per-action retry spacing, so a stuck action cannot burn gas or starve the rest. */
export class Backoff {
  private readonly state = new Map<string, { failures: number; nextTry: number }>();

  constructor(
    private readonly baseMs = 15_000,
    private readonly maxMs = 10 * 60_000,
  ) {}

  canTry(key: string, nowMs: number): boolean {
    const s = this.state.get(key);
    return !s || nowMs >= s.nextTry;
  }

  /** Exponential: base, 2x, 4x, ... up to max. Returns the delay chosen. */
  fail(key: string, nowMs: number): number {
    const failures = (this.state.get(key)?.failures ?? 0) + 1;
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** (failures - 1));
    this.state.set(key, { failures, nextTry: nowMs + delay });
    return delay;
  }

  /** Do not try again before `untilMs`, without counting a failure (e.g. a recoverable push failure). */
  defer(key: string, untilMs: number): void {
    const failures = this.state.get(key)?.failures ?? 0;
    this.state.set(key, { failures, nextTry: untilMs });
  }

  succeed(key: string): void {
    this.state.delete(key);
  }

  size(): number {
    return this.state.size;
  }
}
