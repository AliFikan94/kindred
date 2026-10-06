import { useEffect, useState } from 'react';
import { Address, parseAddress } from './lib/format.js';
import { decodeMeta, Meta } from './lib/share.js';

export type Route =
  | { name: 'create' }
  | { name: 'mine' }
  | { name: 'schedule'; vault: Address; meta: Meta | null; fresh: boolean }
  | { name: 'notfound' };

/**
 * Hash routing, so the app is a static site that works from any path. The fragment is never sent
 * to a server, which is also why share links keep names and notes there.
 *   #/            create          #/mine        my schedules          #/s/<vault>?m=<meta>   a schedule
 */
export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  const [path = '', query = ''] = h.split('?', 2);
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'new')) return { name: 'create' };
  if (parts.length === 1 && parts[0] === 'mine') return { name: 'mine' };
  if (parts.length === 2 && parts[0] === 's') {
    const vault = parseAddress(parts[1]!);
    if (!vault) return { name: 'notfound' };
    const q = new URLSearchParams(query);
    return { name: 'schedule', vault, meta: decodeMeta(q.get('m')), fresh: q.get('new') === '1' };
  }
  return { name: 'notfound' };
}

export const hrefSchedule = (vault: string, encodedMeta?: string): string => `#/s/${vault}${encodedMeta ? `?m=${encodedMeta}` : ''}`;

export function navigate(hash: string): void {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
