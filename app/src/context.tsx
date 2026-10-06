import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppConfig } from './chain/config.js';
import { SimAdapter } from './chain/sim.js';
import { Adapter } from './chain/types.js';
import { friendlyError } from './lib/errors.js';
import { Address } from './lib/format.js';

export interface AppCtx {
  cfg: AppConfig;
  adapter: Adapter;
  sim: SimAdapter | null;
  account: Address | null;
  connect(): Promise<void>;
  toast(msg: string): void;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ cfg, adapter, children }: { cfg: AppConfig; adapter: Adapter; children: ReactNode }) {
  const [account, setAccount] = useState<Address | null>(adapter.account());
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>();

  useEffect(() => adapter.onAccountChange(setAccount), [adapter]);

  const toast = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 4500);
  }, []);

  const connect = useCallback(async () => {
    try {
      await adapter.connect();
    } catch (e) {
      toast(friendlyError(e));
    }
  }, [adapter, toast]);

  const value = useMemo<AppCtx>(
    () => ({ cfg, adapter, sim: adapter instanceof SimAdapter ? adapter : null, account, connect, toast }),
    [cfg, adapter, account, connect, toast],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </Ctx.Provider>
  );
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}
