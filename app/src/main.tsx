import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { readConfig } from './chain/config.js';
import { LiveAdapter } from './chain/live.js';
import { SimAdapter } from './chain/sim.js';
import { AppProvider } from './context.js';
import './styles.css';

const cfg = readConfig(import.meta.env as Record<string, string | undefined>);
const adapter = cfg.mode === 'live' ? new LiveAdapter(cfg, (window as unknown as { ethereum?: never }).ethereum ?? null) : new SimAdapter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider cfg={cfg} adapter={adapter}>
      <App />
    </AppProvider>
  </StrictMode>,
);
