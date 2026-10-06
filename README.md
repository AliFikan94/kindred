# Kindred

Lock something once. It arrives on the day.

Kindred is a set-once, calendar-native scheduler for future value transfers on Monad: a gift for a child's 18th birthday,
a contractor's monthly pay, a community drop. Funds can optionally earn staking rewards while they wait, and a small
open keeper delivers them on the date. If every keeper is down, the recipient can still collect it themselves.

| Folder | What | Tests |
|---|---|---|
| `contracts/` | Solidity (Foundry): per-schedule vaults, staking vault, factory | 129, incl. 13 invariants, 100 % line coverage |
| `keeper/` | The delivery service (TypeScript) | 47, incl. integration against a real node |
| `app/` | The web app: demo mode and live mode | 143 + 23 browser end-to-end |
| `prototype/` | The original design prototype (single file) | n/a |
| `docs/SPEC.md` | The product and contract spec, plus what is actually built and what is still unverified | n/a |

Start with `docs/SPEC.md` (§1 is the promise, §5 the invariants, §14–17 what is built and what is not verified), then
`app/README.md` to try the demo.

**Honest status:** everything runs and is tested against a local node with a faithful test double of Monad's staking contract.
It has not been run on a real Monad network, with a real wallet extension, or with Aurora funding (not built). See each README's
"Not verified" section.
