import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, BrowserContext, chromium, Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
export const APP = join(here, '..');

export async function launch(): Promise<Browser> {
  const exe = process.env.CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  return chromium.launch(exe ? { executablePath: exe } : {});
}

/** Builds the app (optionally with VITE_* env) and serves it statically. Returns the base URL and a stop function. */
export async function buildAndServe(outDir: string, port: number, env: Record<string, string> = {}): Promise<{ url: string; stop(): void }> {
  const run = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(join(APP, 'node_modules/.bin/vite'), args, { cwd: APP, env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`vite ${args.join(' ')} failed:\n${out.slice(-2000)}`))));
    });
  await run(['build', '--outDir', outDir, '--emptyOutDir'], env);
  const srv: ChildProcess = spawn(join(APP, 'node_modules/.bin/vite'), ['preview', '--outDir', outDir, '--port', String(port), '--strictPort'], { cwd: APP, stdio: 'ignore' });
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error('preview server did not start');
  }
  return { url, stop: () => { srv.kill('SIGKILL'); } };
}

export async function newPage(browser: Browser, opts: { width?: number; height?: number; scheme?: 'light' | 'dark' } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 1000, height: opts.height ?? 900 },
    colorScheme: opts.scheme ?? 'light',
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return { ctx, page, errors };
}

export const hasHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
