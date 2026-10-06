# Kindred — Product & Contract Spec (v0.2, hackathon scope)

Status: §14 (vault/factory) and §15 (staking) record what the contracts in `contracts/` actually do. The keeper (§10) and Aurora funding (§8) are not built yet. Items marked **VERIFY** depend on external
facts we have not confirmed and must be checked before we rely on them.

## 1. The promise

> Lock something once. On the exact date you chose, it arrives — whether or not you, the
> recipient, or Kindred are around.

Everything else (staking, cross-chain funding, calendar export) exists to serve or decorate that sentence.

The contract can only keep this promise if **delivery never depends on a single actor**. That gives the rule
the whole design is built on:

> **Unlock is a fact of the contract. Delivery is a service on top of it.**
> At `unlockTime` the funds belong to the recipient and `claim()` works. Keepers *push* the funds
> as a convenience; if every keeper is offline, the recipient can still pull.

## 2. Users and the one demo story

Primary persona: a parent locking MON for a child's 18th birthday, optionally staking while it waits.

The same engine ships two more **presets** (configuration only — no extra contract code):

| Preset | Shape | Defaults |
|---|---|---|
| Family milestone | 1 recipient, 1 date | revocable, staking offered |
| Pay someone monthly | 1 recipient, N monthly dates | revocable, idle |
| Community drop | N recipients, 1 date | revocable, idle |

The demo, video and landing page tell the **family** story only. The other two presets exist and work,
and are mentioned in one line.

## 3. Concepts

- **Schedule** — one funded set of tranches. One contract per schedule (EIP-1167 clone from a factory).
- **Tranche** — `{recipient, asset kind, token, amount | tokenId, unlockTime}`. Max 64 per schedule in v1.
- **Asset kinds (v1):** native MON, ERC-20 (no fee-on-transfer, no rebasing), ERC-721. Not ERC-1155.
- **Strategy** — where locked funds wait: `Idle` or `MonadStake` (native MON only).
- **Keeper** — any account calling `execute`. Paid a small tip. Permissionless.
- **Time** — all unlock times are UTC unix timestamps, computed client-side from calendar dates
  (see §9). The UI shows the local-time equivalent.

## 4. State machine

Schedule:

```
Draft(off-chain) → AwaitingFunds → Active → Closed
                         │            │
                         └→ Refunded  └→ (cancel path, §6) → Closed
```

- `AwaitingFunds`: schedule exists, not fully funded. Has a `fundingDeadline`. Funds that arrive are
  returned to the creator if the deadline passes (`refund()`, callable by anyone).
- `Active`: fully funded; tranches are live.
- `Closed`: every tranche is terminal.

Tranche:

```
Pending ──(time ≥ unlockTime)──► Due ──execute ok──► Delivered
                                  │
                                  ├─ push fails ──► Claimable ──claim──► Delivered
                                  │                      │
                                  │                      └─(grace expired) sweep ─► Swept
                                  └─ claim() directly ─────────────────────────────► Delivered
Pending ──cancel finalized (§6)──► Cancelled (funds returned to creator)
```

`Due` is not stored; it is derived from `block.timestamp >= unlockTime`.

User-facing vocabulary (the only words the UI uses): **Funded · Waiting · Delivered · Needs attention**.
`Needs attention` = `Claimable` (a push failed; the recipient can still claim, and we say how).

## 5. Invariants (tests must try to break each of these)

1. **Destination safety.** Funds only ever move to the tranche recipient, the fallback address, or back to the creator.
2. **Exactness (idle).** A tranche's recipient receives exactly `amount` — fees are never taken from principal.
3. **No post-unlock cancel.** Once `block.timestamp >= unlockTime`, no creator action can touch that tranche.
4. **Isolation.** One tranche failing (blocked recipient, NFT receiver revert, token blacklist) never prevents any other tranche.
5. **Claim liveness.** After `unlockTime`, `claim()` succeeds for the recipient with no keeper involvement (staked funds: after the withdrawal delay, §7).
6. **No double payout.** A tranche reaches `Delivered`/`Swept`/`Cancelled` at most once.
7. **Conservation.** Sum of everything paid out + refunded + fees ≤ everything deposited + yield.
8. **Bounded gas.** `execute` works on one tranche; batching is a loop wrapper with a caller-chosen cap.
9. **No admin keys.** Nobody — including us — can move user funds or change a deployed schedule.
   The factory has only an immutable config set at deploy time.

## 6. Creator controls (deliberate friction)

Mode is chosen at creation and cannot change.

- **Irrevocable:** no cancel, no recipient change by the creator.
- **Revocable:** `requestCancel()` starts a **7-day timelock** (the recipient can see it). `finalizeCancel()`
  after the timelock returns *only tranches that have not yet unlocked* to the creator. Tranches that
  unlock during the timelock still deliver. `abortCancel()` is allowed before finalization.
- **Recipient change:** the current recipient may `setRecipient` immediately (this is how a claim-link
  recipient moves to their own wallet, and how a lost wallet is handled if the recipient still has the key).
  The creator (revocable only) can `proposeRecipient` with the same 7-day timelock.
- No "modify amount/date". To change, cancel and create anew. (Smaller surface, easier to explain.)

## 7. Staking (opt-in, native MON only)

Why: locked principal for 12+ years should not sit idle. Why opt-in: it adds failure modes to a
product whose entire value is reliability. As built: see §15.

**Facts, verified against the precompile's own source** (github.com/category-labs/monad,
`category/execution/monad/staking/staking_contract.cpp`, checked at commit `f20b5b8`, 5 Oct 2026):

- Address `0x…1000`. Calls used: `delegate(uint64) payable` `0x84994fec`, `undelegate(uint64,uint256,uint8)`
  `0x5cf41514`, `withdraw(uint64,uint8)` `0xaed2ee73`, `claimRewards(uint64)` `0xa76e2ca5`,
  view `getDelegator(uint64,address)` `0x573c1ce0`. Mutating calls return an ABI-encoded `true`.
- A delegation must be >= 1 gwei and becomes active in epoch+1 (epoch+2 inside the boundary window).
  Only *active* stake can be undelegated.
- `undelegate` creates a withdrawal request keyed by a `uint8` id that must be unused for that delegator.
  `withdraw` is allowed once `currentEpoch >= requestEpoch + 1`, where `requestEpoch` is itself epoch+1
  (or +2 in the window) — so **up to 3 epochs (~17 h at ~5.5 h/epoch) from undelegate to cash**.
- Rewards accrue to the delegator and are pulled with `claimRewards`; rewards belonging to an unbonding
  slice come back inside its `withdraw`.
- No slashing logic exists in this contract source (only a validator `DoubleSign` flag and a test comment about a
  "slashing window"). The vault is written so that it **never pays more than it received**, in any case.

**Product rules that follow**
- A staked schedule is **irrevocable**: cancelling would require unbonding first, and an unbonding wait in the
  middle of a cancel is not a thing we want to get wrong.
- Only tranches unlocking at least `MIN_STAKE_LEAD` (= `PREPARE_LEAD` + 1 day, 3 days at the 48 h default) after
  staking are staked; sooner ones stay liquid, so nothing is staked "too late to come back".
- Keepers start unbonding a tranche inside the `PREPARE_LEAD` window (48 h before unlock); then the funds are
  liquid at unlock like any other tranche.
- Delivery promise for staked schedules: **on the day when a keeper prepared in time; otherwise at most
  ~3 epochs (~17 h) late even if every keeper is down**, because the recipient's own `claim()` starts unbonding
  and a second `claim()` collects. (Earlier drafts said "about one epoch": that was wrong.)
- Honest dependency: staked funds are only as live as Monad's staking system. If the precompile permanently
  refused `undelegate`/`withdraw`, those tranches would be stuck. This is disclosed, not engineered away.

**Yield accounting (replaces the earlier `totalAssets / totalNominal` idea, which could not be made solvent):**
rewards are *harvested* (`claimRewards`) into the vault and shared among the tranches **currently staked**,
pro-rata to principal, through a per-principal accumulator. A tranche's yield is fixed when it is prepared. It pays
`principal received + yield − 10 % of yield`. Only rewards that are actually in the vault are ever distributed, so
the vault cannot become insolvent by construction.

**Fees:** 10 % of *yield only*, sent to an immutable recipient set at factory deploy. Never from principal.
Keeper tips: 3 per native tranche (prepare, settle, deliver), reserved by the creator at funding.

**Illustration in the UI:** a fixed, clearly labelled assumption (5 % a year gross, 4.5 % after our share). Never a
forecast. Quoted LST yields of 12–14 % are not used.

## 8. Funding

Two paths into the same `AwaitingFunds → Active` transition:

1. **Native (Monad wallet):** one transaction deposits the assets; schedule becomes `Active`.
2. **Cross-chain (Aurora Intents):** the app requests a quote → gets a single-use deposit address →
   the user pays on the source chain → the solver delivers to Monad → the funds land in the
   **schedule's own address**, which flips to `Active` when its balance covers the tranches.
   The schedule has a `fundingDeadline`; a missed deadline or partial fill is refundable on Monad
   (and the UI offers the source-chain refund path).
   **VERIFY:** Aurora Intents API shape (public docs found describe the NEAR Intents 1Click flow: quote →
   deposit address → submit → status), supported destination tokens on Monad, and whether a custom
   post-delivery call is possible. If not, the schedule address receiving plain transfers is the fallback.
   NFTs cannot be bridged this way — they must already be on Monad.

Native path is built and flawless **first**. Cross-chain is a layer on top.

## 9. Calendar semantics

- Client computes UTC timestamps; the contract stores only timestamps (no dates, no names, no birthdays).
- Unlock moment: **00:00 UTC** on the chosen date (the UI shows local equivalent).
- Month-end clamp: "monthly on the 31st" → last day of shorter months.
- Feb 29 anniversaries → Feb 28 in non-leap years (creator can override by picking the date).
- Minimum lead time is a constructor parameter of the factory: 1 day on mainnet, 60 s on the demo
  deployment (this is how the video shows a real on-chain execution).

## 10. Keeper & reliability

- The keeper is **one of several actors** that can trigger delivery; it is not trusted and cannot redirect funds.
- **As built:** `keeper/` (TypeScript, viem). Stateless and idempotent; decides from chain time; dry-runs every action;
  most overdue first; per-action exponential backoff for failed sends (no backoff for "not yet", so a tranche is
  collected on the first tick after it becomes collectable); a tranche whose push failed is retried hourly, not every tick.
  Run two instances with different keys for redundancy.
- Every delivery records `blockTime - unlockTime`. `/status` publishes on-time rate and p50/p95/max lateness.
  Reliability is the product, so it is the one number we publish.
- Not a dependency of correctness: `claim()` always works from the unlock second (staked: ~3 epochs worst case, §7).
- See §16 for what was and was not verified.

## 11. Privacy

On-chain: addresses, amounts, unlock timestamps. Nothing else. Names, birthdays, notes and labels live
off-chain (encrypted at rest, keyed to the creator). v1 does not hide recipients/amounts on-chain;
Merkle-leaf reveal is a post-hackathon option. Minors' birthdates are never written on-chain.

## 12. Scope

**P0 (must ship, in this order)**
1. `ScheduleVault` + factory + Idle strategy + full tests (unit, fuzz, invariants).
2. MonadStake strategy working on testnet.
3. Keeper.
4. Web app: create → fund → sealed → recipient view; ICS export.
5. Aurora funding.
6. Presets (config), demo mode, video, README.

**P1:** notifications (email), public reliability page.
**P2 (stretch):** claim-link recipients (ephemeral key → `setRecipient`), time-capsule note (timelock-encrypted).
**Out of scope:** modify-in-place, ERC-1155, multi-validator, pooled vaults, payout-to-other-chain,
fiat on/off-ramps, yield for stablecoins, upgradeability.

## 13. Open questions to verify (before the dependent step starts)

| # | Question | Blocks |
|---|---|---|
| 1 | Monad staking precompile address & ABI; can a contract be the delegator? | Step 3 |
| 2 | Slashing rules; validator allowlist for testnet | Step 3 |
| 3 | Monad gas model (charged on gas *limit*?) for keeper tip sizing | Keeper |
| 4 | Aurora Intents API, Monad destination tokens, bounty requirements | Step 6 |
| 5 | Testnet faucet + RPC reliability | Step 2 |
| 6 | Passkey / smart-account support on Monad | P2 claim links |

## 14. As built — vault & factory (step 2)

Source: `contracts/src/ScheduleVault.sol`, `ScheduleFactory.sol`. Counts below are for the idle vault; see §15 for totals. Mutation-checked: deliberately
breaking cancel rules, unlock checks, tip accounting, sweep grace, gas guard, effects-before-interaction and
failure isolation each makes at least one test fail.

**Invariants → where they are proven**

| # | Invariant | Proven by |
|---|---|---|
| 1 | Destination safety | `invariant_conservation`, `invariant_nftsOnlyAtLegitDestinations`, `testFuzz_strangerCannotMoveFunds` |
| 2 | Exactness (idle) | `testFuzz_exactDelivery_native/_erc20_viaClaim`, `invariant_conservation` |
| 3 | No post-unlock cancel | `invariant_transitionsAreLegal` (cancelledAfterUnlock), `test_cancel_doesNotTouchTrancheUnlockedButUndelivered` |
| 4 | Isolation | `test_rejectingRecipient_*`, `test_gasBurningRecipient_*`, blocklist / false-return / NFT-receiver tests |
| 5 | Claim liveness | `test_claim_worksWithNoKeeper_fromUnlock`, `test_claim_erc20_and_nft` |
| 6 | No double payout | `test_execute_twiceReverts_noDoublePayout`, `invariant_transitionsAreLegal` |
| 7 | Conservation / solvency | `invariant_conservation`, `invariant_solvent`, `invariant_bookkeeping` |
| 8 | Bounded gas | execute is per-tranche; `executeMany` skips non-due; `test_gasBurningRecipient_isBounded_*` |
| 9 | No admin keys | no privileged functions exist; `test_vault_cannotBeReinitialized`, `test_implementation_cannotBeInitialized` |

**Decisions made while building (these refine, and in places replace, the text above)**

- **One factory, one clone per schedule.** `ScheduleFactory.create(params, tranches, fundNow)`. With `fundNow`
  it pulls ERC-20/721 from `msg.sender` into the new vault and activates in the same tx (native value must match
  exactly). Users approve the factory once (a fixed address). Without it, a draft is created that anyone can
  `activate()` after the address is funded by any means — the Aurora path.
- **Counterfactual funding.** Vault addresses are deterministic (`factory.predict(creator, salt)`), so a bridge
  can deliver assets to the address *before* the vault is deployed and `activate()` sees them.
- **Tip, not "executionDeposit".** The creator pays `tipPerExecution x trancheCount` in native at creation. The
  first attempt on a tranche pays the keeper one tip (success or failure); retries and self-claims pay none;
  unused tips return to the creator at close or on cancel. A keeper that cannot receive its tip never blocks delivery.
- **Failure handling.** A failed push marks the tranche `Claimable` (shown as "Needs attention"); it stays retriable
  by anyone and claimable by the recipient. Pushes forward at most 300k gas and require the caller to have
  supplied enough gas to honour that (a starved caller cannot fake a failure). Return data is never copied.
  Native and ERC-20 results are checked (no-return-value tokens such as USDT are accepted; `false` is a failure).
- **Claim differs from push on purpose.** `claim()` is the recipient's own action: it reverts loudly on failure and
  hands NFTs over with plain `transferFrom` (a contract recipient that cannot take `safeTransfer` can still collect).
- **Sweep covers both `Pending` and `Claimable`** after 365 days past unlock — if neither keepers nor the recipient
  ever acted. Destination: fallback if set and able to receive, otherwise the creator. Before the grace period the
  creator cannot reach unlocked funds at all.
- **Unfunded schedules**: `abandon()` (creator, any time) and `refund()` (anyone, after the funding deadline) close
  the schedule; leftovers return via `withdrawNative / rescueERC20 / rescueERC721`, callable only once Closed.
- **Funding must settle before anything can unlock**: every `unlockTime` must be later than `fundingDeadline`.
- **Unsupported assets fail closed**: fee-on-transfer tokens cannot be activated (balance check fails); the same
  NFT cannot be promised twice; tokens must be contracts.

**Consequences for later steps**

- **Staking (step 3)** adds a second vault implementation behind the same factory interface and overrides the
  native payout path; it does not change this contract's invariants. The 48 h `prepare()` and pro-rata yield
  accounting from §7 are still to build.
- **Keeper cost on Monad:** `execute` needs the caller to supply >= ~365k gas (guard above; `sweep` ~730k since it may try two destinations). If Monad bills the gas
  *limit* rather than gas used (**VERIFY**), the keeper pays for that headroom — size `tipPerExecution` accordingly
  (measured actual use: ~70k for a native tranche, ~175k for a 3-tranche batch).
- **EVM version:** compiled for `cancun`. **VERIFY** the target network supports it (it should).

## 15. As built — staking (step 3)

Source: `contracts/src/StakedScheduleVault.sol` (extends `ScheduleVault` through three small hooks:
`_readyToPay`, `_tipSlots`, and `_init`), `ScheduleFactory.sol` (second implementation, validator allowlist,
fee recipient — all fixed at deploy). **129 tests** across the project, 13 stateful invariants, line coverage 100 %.
Every mutation I tried against the staking maths, fee, timing windows, tip accounting and failure handling is caught.

**Stage machine per native tranche:** `Idle → Staked → Unbonding → Liquid`, with `stakeAll()`,
`prepare()/prepareMany()`, `harvest()` as permissionless external steps. `settle` happens inside
`execute / claim / sweep`, so there is no separate call a recipient must know about.

**What the tests prove (staking-specific)**
- *Conservation*: native across vault + precompile + every participant = start + rewards injected, always.
- *Solvency*: the vault always holds what is liquid-owed (tip reserve, unstaked tranches, settled payouts).
- *No overpayment*: no payout exceeds principal + all rewards ever injected.
- Exact maths with fixed numbers (pro-rata across tranches, a tranche that joins after a harvest, rewards embedded
  in the unbonding slice, a 10 % loss on unbonding, fee recipient absent).
- Failure modes: delegation refused → tranche stays liquid and delivers; stake not yet active → `prepare` fails
  loudly then succeeds; rewards refused → principal still delivered; recipient cannot receive → payout stays fixed
  and claimable; worst-case 2-epoch activation window.

**Found while building (and fixed)**
- The base vault never tipped the keeper of the *last* tranche (closing zeroed the reserve first). Regression test added.
- Unlock-time readiness is not enough for staked funds, so `claim()`/`execute()` on an unprepared tranche now *progress*
  the state (start unbonding) instead of reverting.

**Not verified yet (no network access to Monad from the build environment)**
| Item | Why it matters |
|---|---|
| Gas cost of precompile calls on Monad | guards assume ~900k headroom; `delegate`/`claimRewards` were recalled as ~260k/155k |
| Epoch length in wall-clock time | docs say ~5.5 h; `PREPARE_LEAD` (48 h) has ~3x margin over the worst-case 3 epochs |
| Real validator ids on testnet / mainnet | the allowlist is a constructor argument |
| That `withdraw`/`claimRewards` credit the vault without executing its code | the vault's `receive()` is empty either way |
| Solidity-level call behaviour against the precompile | the vault uses low-level `call` (no `extcodesize` check) on purpose |

The mock precompile (`test/mocks/MockStaking.sol`) reproduces the behaviours read from the source, so passing tests
prove the vault against *that* model — the first testnet run is the real check and should be done before any demo.

## 16. As built — keeper (step 4)

Source: `keeper/` (see its README). **47 tests**, 12 mutation checks, plus an end-to-end run of the real CLI against a
local node using the real `Deploy.s.sol`.

**Verified end to end (local node `anvil`, real contracts, staking mock):** discovery from events; delivery at the exact
unlock second with measured lateness 0; staked lifecycle unattended (prepare at T-48h, wait out unbonding, deliver
principal + 90 % of rewards); recovery when the keeper missed its window; failed push -> claimable -> retried only after the
delay -> delivered once the recipient fixes it; two keepers racing deliver exactly once; funded draft is activated then
staked; unfunded draft is refunded; restart from state file and from a corrupt one; RPC failure mid-tick and mid-scan;
failed sends backed off; graceful shutdown on SIGTERM; `/status` and `/healthz`.

**Found while building:** `ScheduleCreated` did not say whether a vault was staked, so the keeper could not tell vault
types apart from the event alone. The event now carries `staked`.

**Not verified (no access to a Monad network from the build environment)**
| Item | Consequence if wrong |
|---|---|
| Whether `eth_call` / `eth_estimateGas` on Monad behave like a standard node for these calls | the dry-run could mis-classify; floors still hold |
| Gas pricing (limit vs used) and real precompile gas | cost per action; tune `GAS_*` |
| Log-range limits of the real RPC | tune `LOG_CHUNK` |
| Block timestamp granularity / finality (`CONFIRMATIONS`) | lateness figures, reorg handling |
