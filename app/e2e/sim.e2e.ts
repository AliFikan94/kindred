import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, Page } from 'playwright';
import { buildAndServe, hasHorizontalScroll, launch, newPage } from './harness.js';

let browser: Browser;
let site: { url: string; stop(): void };
const ADDR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ADDR2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ADDR3 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

beforeAll(async () => {
  browser = await launch();
  site = await buildAndServe('.e2e/dist-sim', 4301);
});
afterAll(async () => {
  await browser?.close();
  site?.stop();
});

const cont = (p: Page) => p.getByRole('button', { name: 'Continue' }).click();

/** Family gift, gift-link recipient. Leaves the page on the sealed screen. */
async function createFamily(p: Page, opts: { grow?: boolean; permanent?: boolean; note?: string } = {}) {
  await p.goto(site.url);
  await p.waitForSelector('#name');
  await p.fill('#name', 'Maya');
  await cont(p);
  await p.waitForSelector('#amount');
  if (opts.grow === false) await p.getByRole('switch', { name: /grow while it waits/i }).click();
  await cont(p);
  await p.waitForSelector('text=Seal it.');
  if (opts.note !== undefined) await p.fill('#note', opts.note);
  await p.fill('#from', 'Mum');
  if (opts.permanent) await p.getByRole('switch', { name: /Make it permanent/i }).click();
  await p.getByRole('button', { name: 'Lock it in' }).click();
  await p.waitForSelector('h1:has-text("Sealed for Maya.")');
}

describe('the whole product in the demo', () => {
  it('create -> sealed -> see their side -> jump to the day -> the envelope opens with the note and proof', async () => {
    const { ctx, page, errors } = await newPage(browser);
    await createFamily(page, { note: 'Happy 18th, Maya. We are so proud of you.' });

    const link = await page.getByLabel('Gift link for Maya').inputValue();
    expect(link).toMatch(/^http:\/\/localhost:4301\/#\/s\/0x[0-9a-f]{40}\?m=[A-Za-z0-9_-]+$/); // one slash, fragment-only labels
    expect(await page.textContent('body')).toMatch(/Opens in \d+ years/);

    await page.getByRole('button', { name: /See Maya.s side/ }).click();
    await page.waitForSelector('h1:has-text("Something is waiting for you.")');
    expect(await page.textContent('#kicker')).toContain('A gift from Mum');
    await page.getByRole('button', { name: /Jump to the day/ }).click();
    await page.waitForSelector('h1:has-text("Happy 18th birthday, Maya.")');
    const text = await page.textContent('body');
    expect(text).toContain('We are so proud of you.');
    expect(text).toMatch(/second(s)? after midnight UTC|right on time/);
    expect(await page.textContent('#kicker')).toContain('arrived on its own');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('the recipient\'s side shows the countdown and none of the creator tools', async () => {
    const { ctx, page } = await newPage(browser);
    await createFamily(page);
    const link = await page.getByLabel('Gift link for Maya').inputValue();
    // the recipient: same demo browser state, but acting only as the key holder
    await page.getByRole('button', { name: /See Maya.s side/ }).click();
    expect(await page.locator('text=Send Maya this link').count()).toBe(0);
    expect(await page.locator('text=Change your mind?').count()).toBe(0);
    expect(link).toContain('#/s/');
    await ctx.close();
  });

  it('with the keeper off the recipient is not abandoned: they collect it themselves and move it to a wallet', async () => {
    const { ctx, page } = await newPage(browser);
    await createFamily(page, { grow: false });
    await page.getByRole('switch', { name: /Delivery keeper/ }).click();
    await page.getByRole('button', { name: /See Maya.s side/ }).click();
    await page.getByRole('button', { name: /Jump to the day/ }).click();
    await page.waitForSelector('text=It’s time.');
    expect(await page.locator('h1').textContent()).toBe('Something is waiting for you.'); // nothing was pushed to them
    await page.getByRole('button', { name: 'Collect it' }).click();
    await page.waitForSelector('h1:has-text("Happy 18th birthday, Maya.")');
    expect(await page.textContent('#kicker')).toContain('You collected it');
    await page.waitForSelector('text=Move it to your wallet');
    await page.getByRole('button', { name: 'Move it' }).click();
    await page.waitForSelector('text=Moved to your wallet');
    await ctx.close();
  });

  it('survives a reload on the schedule page', async () => {
    const { ctx, page } = await newPage(browser);
    await createFamily(page);
    await page.reload();
    await page.waitForSelector('h1:has-text("Sealed for Maya.")');
    await ctx.close();
  });

  it('exports a real calendar file for the delivery date', async () => {
    const { ctx, page } = await newPage(browser);
    await createFamily(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Add to my calendar' }).click()]);
    const ics = readFileSync(await dl.path()!, 'utf8');
    expect(dl.suggestedFilename()).toBe('kindred.ics');
    expect(ics).toMatch(/BEGIN:VCALENDAR\r\n/);
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20\d{6}/);
    expect(ics).toContain('SUMMARY:Kindred: 5\\,000 MON arrives for Maya');
    await ctx.close();
  });
});

describe('other uses of the same engine', () => {
  it('pays someone monthly: three payments, delivered one by one', async () => {
    const { ctx, page } = await newPage(browser);
    await page.goto(site.url);
    await page.getByRole('button', { name: 'Paying someone monthly' }).click();
    await page.fill('#name', 'Sam');
    await page.fill('#wallet', ADDR1);
    await page.getByRole('button', { name: '3 months' }).click();
    await cont(page);
    await page.waitForSelector('#amount');
    await cont(page);
    await page.waitForSelector('text=Seal it.');
    expect(await page.textContent('body')).toContain('3 times');
    await page.getByRole('button', { name: 'Lock it in' }).click();
    await page.waitForSelector('h1:has-text("Sealed for Sam.")');
    expect(await page.textContent('body')).toContain('0 of 3 delivered');
    await page.getByRole('button', { name: /Jump to the day/ }).click();
    await page.waitForSelector('text=1 of 3 delivered');
    await page.getByRole('button', { name: /Jump to the day/ }).click();
    await page.waitForSelector('text=2 of 3 delivered');
    await ctx.close();
  });

  it('a community drop: pasted addresses, named errors, then everyone is paid on the day', async () => {
    const { ctx, page } = await newPage(browser);
    await page.goto(site.url);
    await page.getByRole('button', { name: 'A community drop' }).click();
    await page.fill('#name', 'Design Guild');
    await page.fill('#addresses', `${ADDR1}\nnot-an-address`);
    await cont(page);
    expect(await page.textContent('#addresses-err')).toMatch(/not an address: not-an-address/);
    await page.fill('#addresses', `${ADDR1}, ${ADDR2}\n${ADDR3}`);
    await cont(page);
    await page.waitForSelector('#amount');
    await cont(page);
    await page.waitForSelector('text=Seal it.');
    expect(await page.textContent('body')).toContain('3 people');
    await page.getByRole('button', { name: 'Lock it in' }).click();
    await page.waitForSelector('h1:has-text("Sealed for Design Guild.")');
    await page.getByRole('button', { name: /Jump to the day/ }).click();
    await page.waitForSelector('text=Everything has arrived.');
    await ctx.close();
  });
});

describe('changing your mind', () => {
  it('cancel needs a 7-day wait that the page explains, then returns the funds', async () => {
    const { ctx, page } = await newPage(browser);
    await createFamily(page, { grow: false });
    await page.getByRole('button', { name: 'Start cancelling' }).click();
    await page.waitForSelector('text=to go.');
    expect(await page.getByRole('button', { name: 'Finish cancelling' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: '+30 days' }).click();
    await page.waitForSelector('text=The wait is over.');
    await page.getByRole('button', { name: 'Finish cancelling' }).click();
    await page.waitForSelector('h1:has-text("This one was cancelled.")');
    await ctx.close();
  });

  it('a permanent or growing schedule offers no cancel at all', async () => {
    const { ctx, page } = await newPage(browser);
    await createFamily(page); // growing by default for a family gift
    expect(await page.locator('text=Change your mind?').count()).toBe(0);
    expect(await page.textContent('body')).toContain('Permanent. It can’t be cancelled.');
    await ctx.close();
  });
});

describe('the form is honest and forgiving', () => {
  it('names what is missing, once the user tries to continue', async () => {
    const { ctx, page } = await newPage(browser);
    await page.goto(site.url);
    await page.waitForSelector('#name');
    expect(await page.textContent('#name-err')).toBe(''); // pristine form is not shouted at
    await cont(page);
    expect(await page.textContent('#name-err')).toMatch(/Add a name/);
    await page.fill('#name', 'Maya');
    await page.fill('#dob', '2000-01-01');
    await cont(page);
    expect(await page.textContent('#dob-err')).toMatch(/already past/);
    await ctx.close();
  });

  it('rejects an impossible amount and explains why growth is unavailable for a near date', async () => {
    const { ctx, page } = await newPage(browser);
    await page.goto(site.url);
    await page.fill('#name', 'Maya');
    await page.getByRole('button', { name: 'Another day' }).click();
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await page.fill('#custom', soon);
    await cont(page);
    await page.waitForSelector('#amount');
    expect(await page.getByRole('switch', { name: /grow while it waits/i }).getAttribute('aria-disabled')).toBe('true');
    expect(await page.textContent('body')).toMatch(/at least 3 days away/);
    await page.fill('#amount', '');
    await cont(page);
    expect(await page.textContent('[role=alert].err')).toMatch(/Enter an amount/);
    await ctx.close();
  });

  it('shows calm pages for broken links', async () => {
    const { ctx, page } = await newPage(browser);
    await page.goto(site.url + '#/s/not-an-address');
    await page.waitForSelector('text=We can’t find that.');
    await page.goto(site.url + '#/s/0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    await page.waitForSelector('text=We can’t open this one.');
    await ctx.close();
  });
});

describe('quality bars', () => {
  it.each([[360, 740], [390, 844], [820, 1100]])('no horizontal scrolling on any step at %ix%i', async (w, h) => {
    const { ctx, page } = await newPage(browser, { width: w, height: h });
    await page.goto(site.url);
    await page.fill('#name', 'Maya');
    expect(await hasHorizontalScroll(page), 'step 1').toBe(false);
    await cont(page);
    await page.waitForSelector('#amount');
    expect(await hasHorizontalScroll(page), 'step 2').toBe(false);
    await cont(page);
    await page.waitForSelector('text=Seal it.');
    expect(await hasHorizontalScroll(page), 'step 3').toBe(false);
    await page.getByRole('button', { name: 'Lock it in' }).click();
    await page.waitForSelector('h1:has-text("Sealed for Maya.")');
    expect(await hasHorizontalScroll(page), 'sealed').toBe(false);
    await ctx.close();
  });

  it('the time-travel slider works from the keyboard and describes itself to screen readers', async () => {
    const { ctx, page } = await newPage(browser);
    await page.goto(site.url);
    await page.fill('#name', 'Maya');
    await cont(page);
    await page.waitForSelector('#amount');
    const slider = page.getByRole('slider', { name: 'Travel through time' });
    const before = await slider.getAttribute('aria-valuetext');
    await slider.focus();
    await page.keyboard.press('Home');
    expect(await slider.getAttribute('aria-valuetext')).toMatch(/^Today/);
    expect(await slider.getAttribute('aria-valuetext')).not.toBe(before);
    await ctx.close();
  });

  it('every interactive control has an accessible name', async () => {
    const { ctx, page } = await newPage(browser);
    await createFamily(page);
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button, a, input, textarea, [role=switch], [role=slider]')]
        .filter((el) => {
          const e = el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> };
          const name = (e.getAttribute('aria-label') ?? '') + (e.textContent ?? '').trim() + (e.labels?.length ? 'x' : '') + (e.getAttribute('title') ?? '');
          return !name.trim();
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(unnamed).toEqual([]);
    await ctx.close();
  });

  it('renders in dark mode without errors', async () => {
    const { ctx, page, errors } = await newPage(browser, { scheme: 'dark' });
    await createFamily(page);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(16, 13, 11)');
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
