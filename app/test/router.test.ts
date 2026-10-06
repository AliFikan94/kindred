import { describe, expect, it } from 'vitest';
import { parseHash } from '../src/router.js';
import { encodeMeta } from '../src/lib/share.js';

const V = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('parseHash', () => {
  it('routes the basics', () => {
    expect(parseHash('')).toEqual({ name: 'create' });
    expect(parseHash('#/')).toEqual({ name: 'create' });
    expect(parseHash('#/new')).toEqual({ name: 'create' });
    expect(parseHash('#/mine')).toEqual({ name: 'mine' });
  });

  it('reads a schedule and its off-chain labels from the fragment', () => {
    const m = encodeMeta({ v: 1, preset: 'family', label: 'Maya', note: 'Hi' });
    const r = parseHash(`#/s/${V.toLowerCase()}?m=${m}`);
    expect(r).toMatchObject({ name: 'schedule', vault: V, meta: { label: 'Maya', note: 'Hi' }, fresh: false });
    expect(parseHash(`#/s/${V}?m=${m}&new=1`)).toMatchObject({ fresh: true });
  });

  it('opens a schedule without labels, and tolerates garbage labels', () => {
    expect(parseHash(`#/s/${V}`)).toEqual({ name: 'schedule', vault: V, meta: null, fresh: false });
    expect(parseHash(`#/s/${V}?m=!!!not-base64`)).toEqual({ name: 'schedule', vault: V, meta: null, fresh: false });
    expect(parseHash(`#/s/${V}?m=${'a'.repeat(9000)}`)).toEqual({ name: 'schedule', vault: V, meta: null, fresh: false });
  });

  it('rejects anything that is not a plain address, never throwing', () => {
    for (const h of ['#/s/', '#/s/nope', '#/s/0x123', `#/s/${V}/extra`, '#/s/' + '0'.repeat(42), '#/unknown', '#/s/<script>alert(1)</script>', '#//s//', '#/s/0x' + '0'.repeat(40)]) {
      expect(parseHash(h), h).toEqual({ name: 'notfound' });
    }
  });
});
