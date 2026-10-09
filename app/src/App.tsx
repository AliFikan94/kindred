import { Component, ReactNode } from 'react';
import { Appearance } from './components/Appearance.js';
import { useApp } from './context.js';
import { shortAddr } from './lib/format.js';
import { useRoute } from './router.js';
import { Create } from './screens/Create.js';
import { Mine } from './screens/Mine.js';
import { Schedule } from './screens/Schedule.js';

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <section className="center">
        <h1>That didn’t work.</h1>
        <p className="lede">Nothing was lost. Reload the page and try again.</p>
        <p style={{ marginTop: 20 }}><button className="link" onClick={() => location.reload()}>Reload</button></p>
      </section>
    );
  }
}

export function App() {
  const route = useRoute();
  const { cfg, account, connect } = useApp();
  return (
    <>
      {cfg.mode === 'sim' && (
        <div className="banner" role="note">
          <div><span><b>Demo.</b> No wallet, no real funds. Everything happens in this browser.</span></div>
        </div>
      )}
      <Appearance />
      <header className="top">
        <a className="logo" href="#/" aria-label="Kindred home"><i />Kindred</a>
        <div className="right">
          {account && <a className="pill" href="#/mine">My schedules</a>}
          {cfg.mode === 'live' && (account
            ? <span className="pill live" title={account}>{shortAddr(account)}</span>
            : <button className="pill" onClick={connect}>Connect</button>)}
          {cfg.mode === 'live' && <span className="pill" title="Network">{cfg.chainName}</span>}
        </div>
      </header>
      <main id="main">
        <Boundary key={JSON.stringify(route)}>
          {route.name === 'create' && <Create />}
          {route.name === 'mine' && <Mine />}
          {route.name === 'schedule' && <Schedule key={route.vault} vault={route.vault} urlMeta={route.meta} fresh={route.fresh} />}
          {route.name === 'notfound' && (
            <section className="center">
              <h1>We can’t find that.</h1>
              <p className="lede">The link may be incomplete. Ask the sender to share it again.</p>
              <p style={{ marginTop: 22 }}><a className="link" href="#/">Start something new</a></p>
            </section>
          )}
        </Boundary>
      </main>
      <p className="foot">{cfg.mode === 'sim' ? 'Kindred demo · mocked chain · illustration only, not financial advice' : 'Illustration only, not financial advice. Rewards vary and are not guaranteed.'}</p>
    </>
  );
}
