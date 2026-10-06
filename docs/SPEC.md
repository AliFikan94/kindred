# Kindred — Product & Contract Spec (v0.1, hackathon scope)

Status: draft for review. Nothing here is built yet. Items marked **VERIFY** depend on external
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
product whose entire value is reliability.

**Facts (documented; VERIFY on testnet before relying):** the Monad staking precompile supports
delegate / undelegate / withdraw / claimRewards; undelegated stake is withdrawable after a delay of
1 epoch (≈ 5.5 h). Sources: docs.monad.xyz staking reference.

**Strategy interface (shared by Idle and MonadStake):**
`deposit(amount)`, `requestWithdraw(amount)`, `finalizeWithdraw()`, `totalAssets()`.

**Delivery for staked tranches:**
- The keeper calls `prepare(trancheId)` **48 h before** `unlockTime` (permissionless; anyone — including the
  recipient — can call it). It starts the undelegation so cash is ready at unlock.
- Normal case: delivery lands at unlock time like any idle tranche.
- Degraded case (nobody prepared): the recipient's claim is available after the withdrawal delay,
  at most ≈ one epoch late. The UI says "within hours" for staked schedules. The promise for staked
  schedules is therefore *"on the day, and never more than ~6 hours late even if everything fails"*.
- Single validator in v1 (chosen at creation, from a short allowlist set at deploy). **VERIFY** slashing
  rules and validator-selection risks. Multi-validator spreading is post-hackathon.

**Yield accounting (simple, symmetrical):** the schedule holds `totalAssets` against `totalNominal`
(sum of undelivered tranche amounts). A tranche pays `amount × totalAssets / totalNominal` at execution
— yield is shared pro-rata, and a loss (slashing) would be shared pro-rata too. No promise of a floor.
For idle schedules the ratio is exactly 1.

**Fees:** 10 % of *yield only*, taken at payout. Never from principal. Keeper tip comes from a small
`executionDeposit` in MON paid by the creator at funding (unused remainder refunded at close), so idle
and ERC-20/NFT schedules also satisfy invariant 2.

**Illustration in the UI:** shown with a fixed, clearly labelled assumption (5 % a year gross,
4.5 % after our share). Never presented as a forecast. Quoted 12–14 % LST yields are not used.

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

- Keeper = a small service that watches schedules and calls `prepare` (staked) and `execute`.
- It is *one* of several actors that can trigger; it is not trusted.
- Run two instances from different hosts. Idempotent: re-calling `execute` on a finished tranche is a harmless revert.
- Every execution records `blockTime - unlockTime`. The public status page shows on-time rate and median delay —
  reliability is the product, so it is the one number we publish.

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
