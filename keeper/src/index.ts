import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Backoff } from './backoff.js';
import { loadConfig } from './config.js';
import { Discovery } from './discovery.js';
import { Executor } from './executor.js';
import { Keeper } from './keeper.js';
import { createLogger } from './log.js';
import { Metrics } from './metrics.js';
import { startStatusServer } from './status.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const chain = defineChain({
    id: cfg.chainId,
    name: 'kindred-target',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const transport = http(cfg.rpcUrl, { batch: true, retryCount: 3, retryDelay: 500 });
  const pub = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(cfg.privateKey);
  const wallet = createWalletClient({ account, chain, transport });

  const discovery = new Discovery(pub, cfg.factory, cfg.fromBlock, cfg.logChunk, cfg.confirmations, cfg.stateFile);
  const metrics = new Metrics(cfg.onTimeSeconds, cfg.metricsFile);
  const keeper = new Keeper(pub, new Executor(pub, wallet, account, chain, cfg), discovery, metrics, new Backoff(), cfg, log, account.address);

  const server = cfg.statusPort > 0 ? startStatusServer(cfg.statusPort, keeper, metrics, cfg.pollMs) : undefined;
  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ((stop = true), log.info('stopping after this tick', { sig })));

  log.info('keeper started', { keeper: account.address, factory: cfg.factory, chainId: cfg.chainId, pollMs: cfg.pollMs, sweep: cfg.sweep });
  while (!stop) {
    const t0 = Date.now();
    const r = await keeper.tick();
    if (r.sent || r.failed || r.newVaults || !r.ok) {
      log.info('tick', { chainTime: r.chainTime, open: r.open, planned: r.planned, sent: r.sent, skipped: r.skipped, failed: r.failed, newVaults: r.newVaults, errors: r.errors });
    }
    await sleep(Math.max(0, cfg.pollMs - (Date.now() - t0)));
  }
  discovery.save();
  server?.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
