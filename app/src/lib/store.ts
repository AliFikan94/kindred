import { Address } from './format.js';
import { decodeMeta, encodeMeta, Meta } from './share.js';

/** Labels live on this device (and in share links), never on a server. All access is best-effort. */
const key = (vault: string) => `kindred:meta:${vault.toLowerCase()}`;

export function saveMeta(vault: Address, meta: Meta): void {
  try {
    localStorage.setItem(key(vault), encodeMeta(meta));
  } catch { /* private mode / quota: the share link still carries everything */ }
}

export function loadMeta(vault: Address): Meta | null {
  try {
    return decodeMeta(localStorage.getItem(key(vault)));
  } catch {
    return null;
  }
}
