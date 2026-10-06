import { useCallback, useEffect, useRef, useState } from 'react';
import { ScheduleView } from './chain/types.js';
import { useApp } from './context.js';
import { friendlyError } from './lib/errors.js';
import { Address } from './lib/format.js';

/** Reads a schedule, keeps it fresh, and exposes `refresh()` for after an action. */
export function useSchedule(vault: Address) {
  const { adapter, cfg } = useApp();
  const [data, setData] = useState<ScheduleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const fetchedAt = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const v = await adapter.get(vault);
      if (!alive.current) return;
      fetchedAt.current = Date.now();
      setData(v);
      setError(null);
    } catch (e) {
      if (alive.current) setError(friendlyError(e));
    }
  }, [adapter, vault]);

  useEffect(() => {
    alive.current = true;
    setData(null);
    setError(null);
    void refresh();
    const t = window.setInterval(() => void refresh(), cfg.mode === 'sim' ? 2000 : 6000);
    return () => {
      alive.current = false;
      window.clearInterval(t);
    };
  }, [refresh, cfg.mode, vault]);

  return { data, error, refresh, fetchedAt };
}

/** Chain time that ticks every second between fetches (so countdowns move smoothly). */
export function useChainClock(chainNow: number | undefined, fetchedAt: number): number {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (chainNow === undefined) return Math.floor(Date.now() / 1000);
  return chainNow + Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000));
}

/** Runs an async action with a busy flag and a friendly error; returns whether it succeeded. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(friendlyError(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, setError };
}
