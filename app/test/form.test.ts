import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DAY, parseISODate, toISODate } from '../src/lib/dates.js';
import { defaultForm, derive, Form, FormCtx } from '../src/lib/form.js';
import { Limits } from '../src/lib/plan.js';

const MON = 10n ** 18n;
const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const NOW = parseISODate('2026-10-06')! + 3600; // 01:00 UTC
const limits: Limits = { now: NOW, minWindow: 60, maxWindow: 30 * DAY, maxTip: MON, stakeLead: 3 * DAY };
const key = generatePrivateKey();
const ctx: FormCtx = { limits, tip: MON / 100n, giftKey: key };
const form = (o: Partial<Form> = {}): Form => ({ ...defaultForm(NOW), name: 'Maya', ...o });

describe('family', () => {
  it('turns a date of birth and a moment into the exact 00:00 UTC unlock', () => {
    const d = derive(form({ dob: '2020-06-08', moment: '18' }), ctx);
    expect(d.errors).toEqual({});
    expect(toISODate(d.plan!.tranches[0]!.unlockTime)).toBe('2038-06-08');
    expect(d.plan!.tranches[0]!.unlockTime % DAY).toBe(0);
    expect(d.momentLabel).toBe('18th birthday');
  });

  it('puts a Feb 29 birthday on Feb 28 (an 18th or 21st anniversary of a leap day is never itself a leap year)', () => {
    for (const [dob, moment, want] of [['2012-02-29', '18', '2030-02-28'], ['2012-02-29', '21', '2033-02-28'], ['2016-02-29', '18', '2034-02-28'], ['2020-02-29', '21', '2041-02-28']] as const) {
      expect(toISODate(derive(form({ dob, moment }), ctx).plan!.tranches[0]!.unlockTime), `${dob} +${moment}`).toBe(want);
    }
  });

  it('says so when the birthday has already passed, and when the date of birth is nonsense', () => {
    expect(derive(form({ dob: '2000-01-01', moment: '18' }), ctx).errors.dob).toMatch(/already past/);
    expect(derive(form({ dob: '2031-01-01' }), ctx).errors.dob).toMatch(/future/);
    expect(derive(form({ dob: '2020-02-30' }), ctx).errors.dob).toMatch(/valid/);
    expect(derive(form({ dob: '' }), ctx).plan).toBeNull();
  });

  it('supports a custom date and a few-minutes demo option', () => {
    expect(toISODate(derive(form({ moment: 'custom', custom: '2030-03-14' }), ctx).plan!.tranches[0]!.unlockTime)).toBe('2030-03-14');
    expect(derive(form({ moment: 'custom', custom: 'soon' }), ctx).errors.custom).toMatch(/valid/);
    const soon = derive(form({ moment: 'soon', soonMinutes: 3 }), ctx);
    expect(soon.issues).toEqual([]); // far enough ahead to clear the funding window and safety margin
    expect(soon.plan!.tranches[0]!.unlockTime - NOW).toBeGreaterThan(60 + 120);
  });

  it('uses a claim-link address by default, or a pasted wallet', () => {
    const link = derive(form(), ctx).plan!;
    expect(link.tranches[0]!.recipient).toBe(privateKeyToAccount(key).address);
    expect(link.key).toBe(key);
    const wallet = derive(form({ recipientMode: 'wallet', wallet: A.toLowerCase() }), ctx).plan!;
    expect(wallet.tranches[0]!.recipient).toBe(A);
    expect(wallet.key).toBeUndefined();
    expect(derive(form({ recipientMode: 'wallet', wallet: '0x12' }), ctx).errors.wallet).toMatch(/0x/);
  });

  it('only keeps the note for family gifts and trims it', () => {
    expect(derive(form({ note: '  Proud of you  ' }), ctx).plan!.note).toBe('Proud of you');
    expect(derive(form({ preset: 'pay', wallet: A, note: 'x' }), ctx).plan!.note).toBeUndefined();
  });
});

describe('amounts and names', () => {
  it('requires both', () => {
    expect(derive(form({ name: '  ' }), ctx).errors.name).toBeTruthy();
    expect(derive(form({ name: 'x'.repeat(41) }), ctx).errors.name).toBeTruthy();
    for (const bad of ['', '0', '-5', '1e3', 'abc', '1,000']) expect(derive(form({ amount: bad }), ctx).errors.amount, bad).toBeTruthy();
    expect(derive(form({ amount: '0.5' }), ctx).plan!.tranches[0]!.amount).toBe(MON / 2n);
  });
});

describe('monthly pay', () => {
  it('builds one payment per month from the start date, clamping month ends', () => {
    const d = derive(form({ preset: 'pay', wallet: B, start: '2027-01-31', months: 4, amount: '1200' }), ctx);
    expect(d.plan!.tranches.map((t) => toISODate(t.unlockTime))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(d.plan!.tranches.every((t) => t.amount === 1200n * MON && t.recipient === B)).toBe(true);
  });
  it('needs a wallet and a valid date', () => {
    expect(derive(form({ preset: 'pay', wallet: '' }), ctx).errors.wallet).toBeTruthy();
    expect(derive(form({ preset: 'pay', wallet: B, start: '2027-13-01' }), ctx).errors.start).toBeTruthy();
  });
  it('flags a first payment that is too soon as an issue the contract would also refuse', () => {
    const d = derive(form({ preset: 'pay', wallet: B, start: '2026-10-06' }), ctx);
    expect(d.issues.join()).toMatch(/future/);
  });
});

describe('community drop', () => {
  it('pays every pasted address the same on the same day', () => {
    const d = derive(form({ preset: 'drop', name: 'Design Guild', addresses: `${A}\n${B}, ${A.toLowerCase()}`, dropDate: '2026-12-01', amount: '100' }), ctx);
    expect(d.plan!.tranches).toHaveLength(3);
    expect(new Set(d.plan!.tranches.map((t) => t.unlockTime)).size).toBe(1);
  });
  it('names the bad entries and enforces the size limit', () => {
    expect(derive(form({ preset: 'drop', addresses: `${A} nope 0x12` }), ctx).errors.addresses).toMatch(/2 entries/);
    expect(derive(form({ preset: 'drop', addresses: 'oops' }), ctx).errors.addresses).toMatch(/not an address/);
    expect(derive(form({ preset: 'drop', addresses: '' }), ctx).errors.addresses).toMatch(/at least one/);
    const many = Array.from({ length: 65 }, () => A).join('\n');
    expect(derive(form({ preset: 'drop', addresses: many }), ctx).errors.addresses).toMatch(/At most 64/);
  });
});

describe('growing and cancelling', () => {
  it('growth is offered only when something would really be staked, and makes the plan permanent', () => {
    const far = derive(form({ moment: 'custom', custom: '2030-01-01', grow: true }), ctx);
    expect(far.growEligible).toBe(true);
    expect([far.plan!.grow, far.plan!.revocable]).toEqual([true, false]);
    expect(far.issues).toEqual([]);

    const near = derive(form({ moment: 'custom', custom: '2026-10-08', grow: true }), ctx);
    expect(near.growEligible).toBe(false);
    expect(near.plan!.grow).toBe(false); // quietly off rather than a confusing error
    expect(near.plan!.revocable).toBe(true);
  });
  it('growth is off where the network offers none', () => {
    const d = derive(form({ moment: 'custom', custom: '2030-01-01', grow: true }), { ...ctx, limits: { ...limits, stakeLead: null } });
    expect([d.growEligible, d.plan!.grow]).toEqual([false, false]);
  });
  it('"make permanent" turns cancelling off', () => {
    expect(derive(form({ moment: 'custom', custom: '2030-01-01', grow: false, permanent: true }), ctx).plan!.revocable).toBe(false);
    expect(derive(form({ moment: 'custom', custom: '2030-01-01', grow: false, permanent: false }), ctx).plan!.revocable).toBe(true);
  });
});

describe('contract-level issues', () => {
  it('a valid plan has none and carries the right value inputs', () => {
    const d = derive(form({ moment: 'custom', custom: '2030-01-01', grow: false }), ctx);
    expect(d.issues).toEqual([]);
    expect(d.plan!.tip).toBe(MON / 100n);
    expect(d.plan!.fundingWindow).toBe(60);
  });
  it('caps the tip at what the factory allows', () => {
    expect(derive(form({ moment: 'custom', custom: '2030-01-01' }), { ...ctx, tip: 5n * MON }).plan!.tip).toBe(MON);
  });
  it('field errors suppress contract issues so users see one thing at a time', () => {
    const d = derive(form({ name: '' }), ctx);
    expect(d.plan).toBeNull();
    expect(d.issues).toEqual([]);
  });
});
