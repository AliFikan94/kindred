import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/backoff.js';

describe('Backoff', () => {
  it('allows the first attempt and blocks until the delay passes', () => {
    const b = new Backoff(1000, 60_000);
    expect(b.canTry('k', 0)).toBe(true);
    expect(b.fail('k', 0)).toBe(1000);
    expect(b.canTry('k', 999)).toBe(false);
    expect(b.canTry('k', 1000)).toBe(true);
  });

  it('doubles per failure and caps', () => {
    const b = new Backoff(1000, 5000);
    expect([b.fail('k', 0), b.fail('k', 0), b.fail('k', 0), b.fail('k', 0)]).toEqual([1000, 2000, 4000, 5000]);
  });

  it('is per key, and success clears', () => {
    const b = new Backoff(1000, 5000);
    b.fail('a', 0);
    expect(b.canTry('b', 0)).toBe(true);
    b.succeed('a');
    expect(b.canTry('a', 0)).toBe(true);
    expect(b.size()).toBe(0);
  });

  it('defer blocks without counting a failure', () => {
    const b = new Backoff(1000, 5000);
    b.defer('k', 10_000);
    expect(b.canTry('k', 9_999)).toBe(false);
    expect(b.canTry('k', 10_000)).toBe(true);
    expect(b.fail('k', 10_000)).toBe(1000); // first real failure still starts at base
  });
});
