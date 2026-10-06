# Kindred

**Lock something once. It arrives on the day.**

Kindred is a set-once, calendar-native scheduler for future value transfers on Monad. You lock funds today, choose real
calendar dates, and they are delivered automatically: a gift for a child's 18th birthday, a contractor's monthly pay, a
community drop. While they wait, funds can earn Monad staking rewards. If our delivery service is ever down, the recipient
can still collect it themselves.

> **Hackathon:** Metropolis, **Track 02: Consumer Products & Payments.**
> **Status:** unaudited prototype for **testnet only**. Do not use it with funds you cannot afford to lose.

## Why this fits Track 02

The primary user is someone who does not identify as a crypto user: a parent giving a gift to a child. The hardest case,
**a recipient with no wallet**, is handled by a *gift link*: the recipient opens a link, sees a countdown, and on the day collects
the gift without installing anything. The product's value is a financial experience (a promise that happens on a date),
not trading.

## Why Monad

- **Native staking from a contract.** Monad exposes its staking system as a precompile that a contract can call. Kindred's
  staked vault delegates, unbonds and withdraws through it on the schedule's behalf, so locked funds earn rewards and are back,
  liquid, in time for their date. This is the Monad-specific part, and it is what makes "locked for years" not mean "idle".
- **Cheap, fast blocks** make small recurring schedules (a monthly payment) and prompt, per-tranche delivery practical.
- Standard EVM tooling (Foundry, viem) works unchanged.

The scheduling logic itself is chain-agnostic; the staking integration is not.

## How it works

```
 creator ──create()──▶ ScheduleFactory ──clones──▶ ScheduleVault (one per schedule, no admin keys)
                                                     │  tranche = {recipient, amount, unlock date}
                       keeper (anyone) ──execute()──▶│  pushes funds on the day, earns a small tip
                       recipient ───────claim()─────▶│  always works from the unlock second, no keeper needed
                                                     └─ StakedScheduleVault: native tranches wait in Monad's staking precompile
                                                        (stake → prepare 48 h ahead → unbond → deliver principal + 90 % of rewards)
```

- **Contracts** (`contracts/`): the vault holds one schedule; delivery is permissionless, and the recipient can always pull.
  A failed push (a recipient that rejects funds) never blocks anyone else. Cancel and recipient changes have a 7-day timelock.
  Growing schedules are permanent. Details and the invariants the tests try to break: [`docs/SPEC.md`](docs/SPEC.md).
- **Keeper** (`keeper/`): a small, untrusted service that dry-runs and sends the due actions, and measures its own lateness.
- **App** (`app/`): create, share and receive schedules. Two backends behind one interface: the real contracts through the
  user's wallet, and an in-browser demo (no wallet) with a time machine. Names and notes live only in the share link's
  `#fragment`; the chain sees addresses, amounts and timestamps.
- **Prototype** (`prototype/`): the original single-file design prototype.

## Tech stack

Solidity 0.8.28 · Foundry · OpenZeppelin Contracts 5.4 (clones, SafeERC20, reentrancy guard) · TypeScript · viem · React 18 · Vite ·
Vitest · Playwright · Anvil (local node for tests).

## Run it

Needs Node 20+ and [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
git clone --recurse-submodules https://github.com/AliFikan94/kindred && cd kindred
(cd contracts && forge build && forge test)         # 129 tests incl. invariants
(cd keeper && npm install && npm test)               # 47 tests (needs anvil on PATH)
(cd app && npm install && npm test && npm run dev)   # 143 tests, then the demo at http://localhost:5173
(cd app && npm run e2e)                              # 23 browser tests (Chromium)
```

The demo needs no wallet and no network. To deploy to Monad testnet and run the real thing, see [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Monad integration and addresses

| | |
|---|---|
| Network | Monad testnet (chain id 10143) |
| ScheduleFactory | **to be filled after deployment** |
| Example schedule transactions | **to be filled after deployment** |

Nothing here is claimed as deployed until the addresses above are filled in.

## Status, honestly

Built and tested locally (against a node with the real contracts and a faithful test double of Monad's staking contract):
contracts, keeper, app. **Not yet done:** deployment on Monad testnet; use with a real wallet extension; funding from other chains
(Aurora Intents, not built, so no Aurora bounty is claimed); ERC-20/NFT screens in the app (the contracts support them).
Every package README has a "not verified" list.

## AI assistance disclosure

This project was built with **Claude Code** (Anthropic's Claude, model Claude Sonnet 5.5) as an AI coding assistant working under the
direction of the project owner. It wrote most of the code, tests and documentation in this repository; commits carry a
`Co-Authored-By: Claude` trailer. The product idea, scope and decisions are the owner's.

## Attribution and licenses

This project is released under the [MIT License](LICENSE). Third-party components, used unmodified:

| Component | Use | License |
|---|---|---|
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) 5.4.0 (git submodule) | clones, SafeERC20, reentrancy guard, initializable | MIT |
| [forge-std](https://github.com/foundry-rs/forge-std) 1.9.7 (git submodule) | contract tests | MIT / Apache-2.0 |
| [viem](https://viem.sh), [React](https://react.dev), [Vite](https://vite.dev), [Vitest](https://vitest.dev), [tsx](https://tsx.is) | app, keeper, tests | MIT |
| [TypeScript](https://www.typescriptlang.org), [Playwright](https://playwright.dev) | build, browser tests | Apache-2.0 |
| [Foundry](https://github.com/foundry-rs/foundry) (forge, anvil) | build and local node (tooling only) | MIT / Apache-2.0 |

Monad's staking precompile: its function selectors and behaviour were read from Monad's public documentation and from the
[`category-labs/monad`](https://github.com/category-labs/monad) source (GPL-3.0) in order to call it correctly. **No code from that
repository is copied**; `contracts/test/mocks/MockStaking.sol` is an independent reimplementation of the behaviour we depend on.
System fonts are used; no third-party fonts or images are bundled.

## Pre-existing work

Everything in this repository was created during the Hackathon period (first commit 5 October 2026). The only prior material is the
third-party components above.
