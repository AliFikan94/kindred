import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/metrics.js';

describe('Metrics', () => {
  it('has no reliability numbers before any delivery', () => {
    const m = new Metrics(60);
    expect(m.summary().onTimeRate).toBeNull();
    expect(m.summary().latenessSeconds).toBeNull();
  });

  it('computes on-time rate and percentiles from deliveries only', () => {
    const m = new Metrics(60);
    for (const l of [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) m.record({ kind: 'delivered', lateness: l });
    m.record({ kind: 'error', detail: 'x' });
    m.record({ kind: 'pushFailed' });
    const s = m.summary();
    expect(s.deliveries).toBe(10);
    expect(s.onTimeRate).toBeCloseTo(0.9);
    expect(s.latenessSeconds).toEqual({ p50: 5, p95: 100, max: 100 });
    expect(s.counts).toMatchObject({ delivered: 10, error: 1, pushFailed: 1 });
  });

  it('keeps only recent events in memory', () => {
    const m = new Metrics(60, undefined, 3);
    for (let i = 0; i < 10; i++) m.record({ kind: 'prepared', id: i });
    expect(m.recent().map((e) => e.id)).toEqual([7, 8, 9]);
  });
});
