import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, Page } from 'playwright';
import { buildAndServe, hasHorizontalScroll, launch, newPage } from './harness.js';

let browser: Browser;
let site: { url: string; stop(): void };
beforeAll(async () => {
  browser = await launch();
  site = await buildAndServe('.e2e/dist-look', 4303);
});
afterAll(async () => {
  await browser?.close();
  site?.stop();
});

const radius = (p: Page, sel: string) => p.$eval(sel, (e) => getComputedStyle(e).borderTopLeftRadius);
const bodyBg = (p: Page) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);

describe('theme and look', () => {
  it('the theme button cycles Auto -> Light -> Dark -> Auto and is remembered across reloads', async () => {
    const { ctx, page } = await newPage(browser, { scheme: 'light' });
    await page.goto(site.url);
    const btn = page.getByRole('button', { name: /Colour theme/ });
    expect(await btn.textContent()).toContain('Auto');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
    await btn.click();
    expect(await btn.textContent()).toContain('Light');
    await btn.click();
    expect(await btn.textContent()).toContain('Dark');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    expect(await bodyBg(page)).toBe('rgb(16, 13, 11)');

    await page.reload();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark'); // no flash: set before render
    expect(await bodyBg(page)).toBe('rgb(16, 13, 11)');
    await page.getByRole('button', { name: /Colour theme/ }).click(); // back to Auto
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
    await ctx.close();
  });

  it('Auto follows the operating system, and an explicit choice overrides it', async () => {
    const dark = await newPage(browser, { scheme: 'dark' });
    await dark.page.goto(site.url);
    expect(await bodyBg(dark.page)).toBe('rgb(16, 13, 11)'); // OS dark, Auto
    await dark.page.getByRole('button', { name: /Colour theme/ }).click(); // Light
    expect(await bodyBg(dark.page)).toBe('rgb(246, 242, 235)'); // explicit light beats OS dark
    await dark.ctx.close();
  });

  it('the look switch changes shape: pills in classic, square corners in stationery', async () => {
    const { ctx, page } = await newPage(browser);
    await page.emulateMedia({ reducedMotion: 'reduce' }); // our CSS honours this, so computed values are not mid-animation
    await page.goto(site.url);
    await page.waitForSelector('#name');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe('classic');
    expect(await radius(page, '.cta')).toBe('99px');
    expect(await radius(page, '.chip')).toBe('99px');
    await page.getByRole('button', { name: 'Stationery' }).click();
    expect(await radius(page, '.cta')).toBe('2px');
    expect(await radius(page, '.chip')).toBe('2px');
    expect(await page.getByRole('button', { name: 'Stationery' }).getAttribute('aria-pressed')).toBe('true');
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe('stationery'); // remembered
    expect(await radius(page, '.cta')).toBe('2px');
    await ctx.close();
  });

  it('a link can set the look and theme', async () => {
    const { ctx, page } = await newPage(browser);
    await page.goto(`${site.url}?look=stationery&theme=dark`);
    expect(await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.theme])).toEqual(['stationery', 'dark']);
    await ctx.close();
    const fresh = await newPage(browser);
    await fresh.page.goto(`${site.url}?look=<b>&theme=%00`);
    expect(await fresh.page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.hasAttribute('data-theme')])).toEqual(['classic', false]); // junk ignored
    await fresh.ctx.close();
  });

  it('the delivery postmark shows only in the stationery look', async () => {
    const { ctx, page } = await newPage(browser);
    await page.goto(site.url);
    await page.fill('#name', 'Maya');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Lock it in' }).click();
    await page.waitForSelector('text=Sealed for Maya.');
    await page.getByRole('button', { name: /See Maya.s side/ }).click();
    await page.getByRole('button', { name: /Jump to the day/ }).click();
    await page.waitForSelector('text=Happy 18th birthday, Maya.');
    expect(await page.locator('.postmark').isVisible()).toBe(false);
    expect(await page.locator('.proof-plain').isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Stationery' }).click();
    expect(await page.locator('.postmark').isVisible()).toBe(true);
    expect(await page.locator('.proof-plain').isVisible()).toBe(false);
    expect(await page.locator('.postmark').getAttribute('aria-label')).toMatch(/^Delivered \d{2} [A-Z]{3} \d{4} at \d{2}:\d{2}:\d{2} UTC$/);
    await ctx.close();
  });

  it.each([[360, 740], [390, 844]])('stationery has no horizontal scroll at %ix%i on any step', async (w, h) => {
    const { ctx, page } = await newPage(browser, { width: w, height: h });
    await page.goto(`${site.url}?look=stationery`);
    await page.fill('#name', 'Maya');
    expect(await hasHorizontalScroll(page)).toBe(false);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('#amount');
    expect(await hasHorizontalScroll(page)).toBe(false);
    await page.getByRole('button', { name: 'Continue' }).click();
    expect(await hasHorizontalScroll(page)).toBe(false);
    await page.getByRole('button', { name: 'Lock it in' }).click();
    await page.waitForSelector('text=Sealed for Maya.');
    expect(await hasHorizontalScroll(page)).toBe(false);
    await ctx.close();
  });
});

/** WCAG contrast of the text people actually read, measured in the browser for every look x theme. */
describe.each([
  ['classic', 'light'], ['classic', 'dark'], ['stationery', 'light'], ['stationery', 'dark'],
])('legibility: %s / %s', (look, theme) => {
  const MEASURE = `
    (() => {
      const parse = (c) => {
        let m = c.match(/rgba?\\(([^)]+)\\)/);
        if (m) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
        m = c.match(/color\\(srgb ([^)]+)\\)/);
        if (m) { const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] ?? 1 }; }
        return { r: 0, g: 0, b: 0, a: 1 };
      };
      const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const bgOf = (el) => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) {
          const s = getComputedStyle(e);
          if (s.backgroundImage !== 'none') return null; // gradient: not measurable here
          const c = parse(s.backgroundColor);
          if (c.a > 0) layers.push(c);
          if (c.a >= 1) break;
        }
        let base = { r: 255, g: 255, b: 255, a: 1 };
        for (const l of layers.reverse()) base = blend(l, base);
        return base;
      };
      const out = [];
      const check = (label, el, pseudo) => {
        if (!el) return;
        const s = getComputedStyle(el, pseudo);
        const bg = bgOf(el);
        if (!bg) return;
        const fg = blend(parse(s.color), bg);
        const L1 = lum(fg), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const px = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
        const large = px >= 24 || (px >= 18.66 && bold);
        out.push({ label, ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5 });
      };
      return { check, out };
    })()`;

  it('keeps text readable on the create steps and the opened letter', async () => {
    const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
    await page.goto(`${site.url}?look=${look}&theme=${theme}`);
    await page.waitForSelector('#name');
    const run = (items: Array<[string, string, string?]>) =>
      page.evaluate(
        ({ items, src }) => {
          const m = (0, eval)(src) as { check(l: string, e: Element | null, p?: string): void; out: unknown[] };
          for (const [label, sel, pseudo] of items) m.check(label, document.querySelector(sel), pseudo);
          return m.out as Array<{ label: string; ratio: number; need: number }>;
        },
        { items, src: MEASURE },
      );
    const results: Array<{ label: string; ratio: number; need: number }> = [];

    results.push(...(await run([['h1', 'h1'], ['lede', '.lede'], ['label', '.lbl'], ['input', '#name'], ['placeholder', '#name', '::placeholder'], ['chip', '.chip[aria-pressed="false"]'], ['chip selected', '.chip[aria-pressed="true"]'], ['cta', '.cta'], ['banner', '.banner'], ['appearance button', '.appearance .mini[aria-pressed="false"]'], ['pill', '.pill']])));
    await page.fill('#name', 'Maya');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('#amount');
    results.push(...(await run([['amount', '#amount'], ['amount placeholder', '#amount', '::placeholder'], ['switch text', '.switch .small'], ['fine print', '.fine']])));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Lock it in' }).click();
    await page.waitForSelector('text=Sealed for Maya.');
    results.push(...(await run([['ledger term', '.summary dt'], ['ledger value', '.summary dd'], ['panel text', '.panel p'], ['countdown', '.countdown'], ['status', '.status .s']])));
    await page.getByRole('button', { name: /See Maya.s side/ }).click();
    await page.getByRole('button', { name: /Jump to the day/ }).click();
    await page.waitForSelector('text=Happy 18th birthday, Maya.');
    await page.waitForTimeout(1300);
    results.push(...(await run([['letter amount', '.letter .amt'], ['letter note', '.letter .words'], ['letter arrived line', '.letter .arrived'], ['letter to', '.letter .to'], ['proof', '.proof'], ['postmark', '.postmark']])));

    const failures = results.filter((r) => r.ratio < r.need).map((r) => `${r.label}: ${r.ratio} (needs ${r.need})`);
    expect(failures, `${look}/${theme}`).toEqual([]);
    await ctx.close();
  });
});
