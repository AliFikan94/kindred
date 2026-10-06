import { createServer, Server } from 'node:http';
import { Keeper } from './keeper.js';
import { Metrics } from './metrics.js';

const json = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/**
 * Tiny read-only HTTP surface:
 *   /status   everything below, as JSON (the seed of a public reliability page)
 *   /healthz  200 while ticks keep succeeding, 503 otherwise (for a process supervisor)
 */
export function startStatusServer(port: number, keeper: Keeper, metrics: Metrics, pollMs: number, clock = Date.now): Server {
  const server = createServer((req, res) => {
    const s = keeper.status;
    const staleMs = Math.max(30_000, pollMs * 4);
    const healthy = s.lastOkTickAt !== null && clock() - s.lastOkTickAt < staleMs;
    if (req.url === '/healthz') {
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'text/plain' });
      res.end(healthy ? 'ok' : 'stale');
      return;
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy, ...s, reliability: metrics.summary(), recent: metrics.recent().slice(-20) }, json, 2));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '0.0.0.0');
  return server;
}
