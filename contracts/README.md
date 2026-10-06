# Kindred contracts

Solidity 0.8.28, Foundry. OpenZeppelin v5.4 and forge-std are git submodules.

```bash
git submodule update --init --recursive
forge test                 # unit + fuzz + invariants (~15 s)
forge test --match-contract InvariantTest -vv
forge coverage --report summary --no-match-coverage "test|mocks"
```

- `src/ScheduleVault.sol` — one instance (EIP-1167 clone) per schedule. No admin keys, not upgradeable.
- `src/StakedScheduleVault.sol` — the same vault, but native tranches wait in Monad's staking precompile (opt-in, irrevocable).
- `src/ScheduleFactory.sol` — deploys either kind of clone, optionally funds and activates (and stakes) in one transaction.
- `test/` — `ScheduleVault.t.sol` (behaviour, hostile recipients/tokens, fuzz), `ScheduleFactory.t.sol`,
  `Invariant.t.sol` (stateful fuzzing of every external function), `StakedVault.t.sol` + `StakedInvariant.t.sol`
  (staking lifecycle and its invariants against `mocks/MockStaking.sol`), `mocks/` (adversarial tokens and recipients).

See `docs/SPEC.md` §5 for the invariants, §14–15 for how each is proven and what is still unverified.
