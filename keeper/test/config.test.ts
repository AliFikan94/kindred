import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { revertReason } from '../src/executor.js';

const good = {
  RPC_URL: 'http://localhost:8545',
  CHAIN_ID: '10143',
  FACTORY: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  KEEPER_PRIVATE_KEY: '0x' + '11'.repeat(32),
};

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig(good);
    expect(c.sweep).toBe(false); // sweeping moves funds away from a recipient: opt-in only
    expect(c.pollMs).toBe(5000);
    expect(c.fromBlock).toBe(0n);
    expect(c.gas.executeStaked).toBeGreaterThan(c.gas.executeIdle);
  });

  it('requires the essentials and says which one is missing', () => {
    for (const k of Object.keys(good)) {
      const env = { ...good } as Record<string, string | undefined>;
      delete env[k];
      expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(k);
    }
  });

  it('rejects malformed keys and addresses', () => {
    expect(() => loadConfig({ ...good, KEEPER_PRIVATE_KEY: '0x1234' })).toThrow(/32-byte/);
    expect(() => loadConfig({ ...good, FACTORY: 'nope' })).toThrow(/address/);
  });

  it('reads overrides', () => {
    const c = loadConfig({ ...good, SWEEP: 'true', POLL_MS: '250', GAS_PREPARE: '2000000', FROM_BLOCK: '123' });
    expect(c.sweep).toBe(true);
    expect(c.pollMs).toBe(250);
    expect(c.gas.prepare).toBe(2_000_000n);
    expect(c.fromBlock).toBe(123n);
  });
});

describe('revertReason', () => {
  it('finds the custom error name through nested causes', () => {
    const e = { message: 'outer', cause: { cause: { data: { errorName: 'NotExecutable' } } } };
    expect(revertReason(e)).toBe('NotExecutable');
  });

  it('falls back to the first line of the message', () => {
    expect(revertReason(new Error('boom\nstack'))).toBe('boom');
    expect(revertReason('plain')).toBe('plain');
  });
});
