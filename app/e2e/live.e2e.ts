import { ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, Page } from 'playwright';
import { alice, bob, creator, deploy, Deployed, keeper, Node, startAnvil } from '../test/chain-helpers.js';
import { buildAndServe, launch, newPage } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
let browser: Browser;
let node: Node;
let d: Deployed;
let site: { url: string; stop(): void };
let keeperProc: ChildProcess | undefined;
const ANVIL_PORT = 41_000 + Math.floor(Math.random() * 3000);

beforeAll(async () => {
  browser = await launch();
  node = await startAnvil(ANVIL_PORT);
  d = await deploy(node);
  site = await buildAndServe('.e2e/dist-live', 4302, {
    VITE_FACTORY: d.factory,
    VITE_CHAIN_ID: '31337',
    VITE_CHAIN_NAME: 'Anvil',
    VITE_RPC_URL: node.url,
    VITE_FACTORY_BLOCK: d.cfg.factoryBlock.toString(),
    VITE_VALIDATOR_ID: '7',
    VITE_DEMO: '1',
    VITE_TIP_WEI: '10000000000000000',
  });
  // the real keeper, as a separate process, exactly as it would run in production
  const kdir = join(here, '..', '..', 'keeper');
  keeperProc = spawn(join(kdir, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: kdir,
    stdio: 'ignore',
    env: {
      ...process.env,
      RPC_URL: node.url, CHAIN_ID: '31337', FACTORY: d.factory, FROM_BLOCK: d.cfg.factoryBlock.toString(),
      KEEPER_PRIVATE_KEY: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', POLL_MS: '300', LOG_LEVEL: 'error',
    },
  });
});

afterAll(async () => {
  keeperProc?.kill('SIGKILL');
  await browser?.close();
  site?.stop();
  node?.stop();
});

/** A wallet stand-in injected before the page loads: signs through anvil's unlocked dev account. */
const injectWallet = (page: Page, account: string) =>
  page.addInitScript(
    ({ rpc, account }) => {
      let connected = false;
      const call = async (method: string, params: unknown[]) => {
        const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        return j.result;
      };
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method, params = [] }: { method: string; params?: unknown[] }) {
          if (method === 'eth_requestAccounts') { connected = true; return [account]; }
          if (method === 'eth_accounts') return connected ? [account] : [];
          if (method === 'eth_chainId') return '0x7a69';
          if (method === 'wallet_switchEthereumChain') return null;
          if (method === 'eth_sendTransaction') return call(method, [{ ...(params[0] as object), from: account }]);
          return call(method, params);
        },
        on() {}, removeListener() {},
      };
    },
    { rpc: node.url, account },
  );

const chainTime = async () => Number((await node.pub.getBlock({ blockTag: 'latest', includeTransactions: false })).timestamp);
const balance = (a: string) => node.pub.getBalance({ address: a as `0x${string}` });
const MON = 10n ** 18n;

describe('with a real wallet, real contracts and the real keeper', () => {
  it('connects, creates a gift for a wallet address, and the keeper delivers it on the day while the page watches', async () => {
    const { ctx, page, errors } = await newPage(browser);
    await injectWallet(page, creator.address);
    await page.goto(site.url);
    await page.waitForSelector('#name');
    expect(await page.getByRole('button', { name: 'Connect' }).count()).toBe(1); // not connected until the user says so
    await page.fill('#name', 'Maya');
    await page.getByRole('button', { name: 'In a few minutes' }).click();
    await page.getByRole('button', { name: 'I have their address' }).click();
    await page.fill('#wallet', alice.address);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('#amount');
    await page.fill('#amount', '5');
    expect(await page.getByRole('switch', { name: /grow while it waits/i }).getAttribute('aria-disabled')).toBe('true'); // minutes away: nothing to stake
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('text=Seal it.');
    await page.getByRole('button', { name: 'Connect wallet & lock it in' }).click();
    await page.waitForSelector('h1:has-text("Sealed for Maya.")', { timeout: 30_000 });
    expect(await page.textContent('header')).toContain(creator.address.slice(0, 6)); // now connected

    // the schedule is really on-chain, holding exactly what the page said
    const vault = (await page.evaluate(() => location.hash)).match(/0x[0-9a-fA-F]{40}/)![0] as `0x${string}`;
    expect(await balance(vault)).toBe(5n * MON + 10n ** 16n); // principal + one tip slot

    const before = await balance(alice.address);
    const unlock = Number((await node.pub.readContract({ address: vault, abi: d.vaultAbi, functionName: 'tranche', args: [0n] } as never) as { unlockTime: bigint }).unlockTime);
    await node.warpTo(unlock); // the day arrives; nobody touches anything

    await page.waitForSelector('text=Everything has arrived.', { timeout: 30_000 });
    expect((await balance(alice.address)) - before).toBe(5n * MON);
    expect(await page.textContent('body')).toMatch(/Delivered (right on time|\d+ seconds? after midnight UTC)/);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('a gift link works on a device with no wallet: it counts down, is delivered by the keeper, and can be moved to a real wallet', async () => {
    // creator side
    const creatorSide = await newPage(browser);
    await injectWallet(creatorSide.page, creator.address);
    const p = creatorSide.page;
    await p.goto(site.url);
    await p.fill('#name', 'Maya');
    await p.getByRole('button', { name: 'In a few minutes' }).click();
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.waitForSelector('#amount');
    await p.fill('#amount', '7');
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.fill('#note', 'For you, with love.');
    await p.getByRole('button', { name: 'Connect wallet & lock it in' }).click();
    await p.waitForSelector('h1:has-text("Sealed for Maya.")', { timeout: 30_000 });
    const link = await p.getByLabel('Gift link for Maya').inputValue();
    await creatorSide.ctx.close();

    // recipient side: a brand-new browser profile with no wallet at all
    const child = await newPage(browser);
    await child.page.goto(link);
    await child.page.waitForSelector('h1:has-text("Something is waiting for you.")', { timeout: 30_000 });
    expect(await child.page.textContent('#kicker')).toContain('A gift from someone who cares about you'); // no sender name was given
    expect(await child.page.textContent('body')).toMatch(/Opens in/);
    expect(await child.page.locator('text=Change your mind?').count()).toBe(0);

    const vault = link.match(/0x[0-9a-fA-F]{40}/)![0] as `0x${string}`;
    const unlock = Number((await node.pub.readContract({ address: vault, abi: d.vaultAbi, functionName: 'tranche', args: [0n] } as never) as { unlockTime: bigint }).unlockTime);
    await node.warpTo(unlock);

    await child.page.waitForSelector('h1:has-text("It’s yours.")', { timeout: 30_000 });
    expect(await child.page.textContent('body')).toContain('For you, with love.');
    await child.page.waitForSelector('text=Move it to your wallet', { timeout: 30_000 });

    const before = await balance(bob.address);
    await child.page.fill('#dest', bob.address);
    await child.page.getByRole('button', { name: 'Move it' }).click();
    await child.page.waitForSelector('text=Moved to your wallet', { timeout: 30_000 });
    const gained = (await balance(bob.address)) - before;
    expect(gained).toBeGreaterThan(7n * MON);
    expect(gained).toBeLessThanOrEqual(7n * MON + 2n * 10n ** 16n); // the gift plus whatever gas the link still carried
    await child.ctx.close();
  });

  it('a growing schedule is created staked and permanent, and says so', async () => {
    const { ctx, page } = await newPage(browser);
    await injectWallet(page, creator.address);
    await page.goto(site.url);
    await page.fill('#name', 'Maya');
    await page.getByRole('button', { name: 'Another day' }).click();
    const far = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    await page.fill('#custom', far);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('#amount');
    await page.fill('#amount', '100');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('text=Seal it.');
    expect(await page.textContent('body')).toContain('Staked on Monad');
    await page.getByRole('button', { name: 'Connect wallet & lock it in' }).click();
    await page.waitForSelector('h1:has-text("Sealed for Maya.")', { timeout: 30_000 });
    const body = await page.textContent('body');
    expect(body).toMatch(/Staked on Monad|Growing on Monad/);
    expect(body).toContain('Permanent. It can’t be cancelled.');
    expect(await page.locator('text=Change your mind?').count()).toBe(0);
    const vault = (await page.evaluate(() => location.hash)).match(/0x[0-9a-fA-F]{40}/)![0];
    const tr = (await node.pub.readContract({ address: vault as `0x${string}`, abi: d.stakedAbi, functionName: 'stage', args: [0n] } as never)) as number;
    expect(Number(tr)).toBe(1); // Stage.Staked on-chain
    await ctx.close();
  });

  it('shows a calm, specific message when the wallet refuses', async () => {
    const { ctx, page } = await newPage(browser);
    await page.addInitScript((account) => {
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method }: { method: string }) {
          if (method === 'eth_requestAccounts') return [account];
          if (method === 'eth_accounts') return [];
          if (method === 'eth_chainId') return '0x7a69';
          throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        },
        on() {}, removeListener() {},
      };
    }, creator.address);
    await page.goto(site.url);
    await page.fill('#name', 'Maya');
    await page.getByRole('button', { name: 'Another day' }).click();
    await page.fill('#custom', new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /lock it in/i }).click();
    await page.waitForSelector('text=You cancelled the request in your wallet.', { timeout: 20_000 });
    expect(await page.locator('h1:has-text("Sealed")').count()).toBe(0); // nothing was created
    await ctx.close();
  });

  it('refuses a schedule from another factory instead of presenting it as genuine', async () => {
    const other = await deploy(node);
    const { ctx, page } = await newPage(browser);
    const { LiveAdapter } = await import('../src/chain/live.js');
    const { anvilProvider } = await import('../test/chain-helpers.js');
    const a = new LiveAdapter(other.cfg, anvilProvider(node, creator.address));
    await a.connect();
    const { familyTranches } = await import('../src/lib/plan.js');
    const { vault } = await a.create({
      preset: 'family', label: 'Fake', tranches: familyTranches(alice.address, MON, (await chainTime()) + 5 * 86400),
      grow: false, revocable: true, tip: 10n ** 16n, fundingWindow: 60,
    });
    await page.goto(`${site.url}#/s/${vault}`);
    await page.waitForSelector('text=We can’t open this one.', { timeout: 20_000 });
    expect(await page.textContent('body')).toMatch(/not a Kindred schedule/i);
    await ctx.close();
  });
});

void keeper;
