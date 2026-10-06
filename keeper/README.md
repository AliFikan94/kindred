# Kindred keeper

A small, **untrusted** service that makes scheduled transfers happen on time. It holds a key with gas money only:
it cannot move anyone's funds anywhere except to the recipient the schedule already names, because the contracts
only expose permissionless "make progress" calls (`execute`, `prepare`, `activate`, `stakeAll`, `refund`).
If the keeper is down, recipients can still `claim()` on the day (see `docs/SPEC.md` §1).

## What it does each tick

1. Reads the latest block (**chain time**, never the wall clock).
2. Finds new schedules from the factory's `ScheduleCreated` events.
3. Reads each open schedule and plans the actions that are due (`src/planner.ts`, a pure function):
   `activate` / `refund` unfunded drafts, `stakeAll`, `prepare` a staked tranche inside its 48 h window,
   `execute` due tranches (most overdue first), optionally `sweep`.
4. **Dry-runs every action** (`eth_call`). Anything that would revert (someone else did it, not time yet,
   unbonding not finished) is skipped, not sent.
5. Sends with a gas limit that is at least what the contract's own guards require, waits for the receipt,
   and reads the tranche back to record what *actually* happened (delivered / push failed but claimable / unbonding started).

It is stateless: delete the state file and it rebuilds the same view from the chain. Two instances (different keys)
can run side by side; the worst case of a race is one wasted dry-run or reverted transaction, never a double payout.

## Run

```bash
cd contracts && forge build && cd ../keeper
npm install
npm run abi          # only needed if the contracts' ABI changed
cp .env.example .env # then edit
set -a; . ./.env; set +a
npm start
```

| Env var | Meaning | Default |
|---|---|---|
| `RPC_URL`, `CHAIN_ID`, `FACTORY` | network and the deployed `ScheduleFactory` | required |
| `KEEPER_PRIVATE_KEY` | key that pays gas and receives tips | required |
| `FROM_BLOCK` | block of the factory deployment | `0` |
| `POLL_MS` | tick interval | `5000` |
| `STATE_FILE`, `METRICS_FILE` | cache and JSONL log of events | off |
| `STATUS_PORT` | serve `/status` and `/healthz` | off |
| `MAX_ACTIONS_PER_TICK` | cap per tick, most overdue first | `10` |
| `SWEEP` | also sweep unclaimed funds after 365 days (moves funds away from a recipient) | `false` |
| `CLAIMABLE_RETRY_MS` | wait before retrying a tranche whose push failed | `3600000` |
| `ON_TIME_SECONDS` | threshold for the on-time rate | `60` |
| `GAS_*` | gas-limit **floors** per action (never caps) | see `src/config.ts` |

`/status` returns the keeper's own reliability numbers (deliveries, on-time rate, p50/p95/max lateness in seconds):
that is the number the product is selling, so it is measured and exposed from day one. `/healthz` is 200 while ticks succeed.

## Test

```bash
cd contracts && forge build          # artifacts used by the integration tests
cd ../keeper && npm test             # 47 tests; needs `anvil` (Foundry) on PATH or ANVIL_BIN
```

- `planner.test.ts`: exhaustive cases for the pure decision logic (exact-second boundaries, windows, ordering).
- `integration.test.ts`: real `anvil` node, the real compiled contracts, the staking mock at `0x1000`, exact time control.
  Covers the full staked lifecycle, a keeper that missed its window, a recipient that rejects funds, two keepers racing,
  drafts funded later, refunds, restarts, a corrupt state file, flaky RPC, a half-failed log scan, failed sends and backoff.
- Mutation-checked: 12 deliberate breakages (off-by-one on the unlock second, wall-clock instead of chain time, no dry-run, lost
  cursor, no backoff, ...) are each caught by at least one test.

## Operating notes

- **Fund the keeper with a little native token.** It warns (`lowBalance` in `/status`) below `MIN_BALANCE_WEI`.
- **Gas on Monad is unverified.** If Monad charges the gas *limit*, the floors cost real money per action; they exist because
  the contracts refuse to run a push with less (so a starved transaction cannot fake a failure). Tune `GAS_*` once real costs are known.
- **Tips** (reserved by each schedule's creator) usually exceed the gas for an action on a cheap chain; they are not a profit
  centre and the keeper does not check profitability.
- **Scaling later:** the per-tick scan is O(open schedules). Past a few thousand, replace it with a priority queue keyed by
  next due time (the planner already computes `dueAt`) fed by the event stream, and shard by vault address across instances.
