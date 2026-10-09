# Kindred app

Create, share and receive scheduled transfers. React + Vite + viem. A static site: no server, no database.

```bash
npm install
npm run dev          # in-browser demo (no wallet, no chain needed)
npm run build        # static files in dist/, host anywhere (relative paths, hash routing)
```

## Two backends behind one interface (`src/chain/types.ts`)

| | `LiveAdapter` | `SimAdapter` |
|---|---|---|
| Used when | `VITE_FACTORY` is set | it is not |
| Talks to | the real contracts, through the user's wallet (EIP-1193) | an in-browser model |
| For | the product | trying it with nothing installed: includes a **time machine** and a **keeper on/off** switch |

`test/conformance.test.ts` runs the same scenarios against both, on a real node, so the simulator cannot drift from the contracts
without a test failing.

## Configuration

Copy `.env.example`. A live build needs the deployed factory (see `contracts/script/Deploy.s.sol`), chain id, RPC URL and the
factory's deployment block. `VITE_DEMO=1` adds "in a few minutes" so a real on-chain delivery can be shown on camera.

## How it handles data

- **On-chain:** addresses, amounts, unlock times only (SPEC §11).
- **Names, notes, "from":** live in the share link's `#fragment` (never sent to a server) and in `localStorage` on the creator's device.
  Share links are treated as hostile input: size-limited, strictly decoded, control characters stripped.
- **A schedule is only shown as genuine if the configured factory created it** (checked from the factory's event log). A link to
  any other contract gets "not a Kindred schedule".
- **Gift links** (recipient has no wallet) carry a private key in the fragment. Anyone with the link can collect, and the UI says so.
  The creator also drips a little gas to that address so the recipient can collect without any keeper.

## Test

```bash
cd ../contracts && forge build     # artifacts used by the chain tests
npm test                            # 150 tests: logic, live adapter vs real contracts, simulator, conformance, appearance (needs `anvil`)
npm run e2e                         # 34 browser tests (Chromium): the demo end to end, a live run with a real keeper, looks and legibility
```

The live end-to-end run builds the app against a local node, injects a wallet stand-in, starts the **real keeper process**, moves chain
time, and checks the page and the balances: including a gift link opened on a device with no wallet, delivered by the keeper, then moved
to another wallet.

## Appearance

Two looks and light/dark, switchable from the bar under the header (and by link: `?look=stationery&theme=dark`):

- **Classic**: soft, rounded, the original look.
- **Stationery**: formal paper-and-ink. Square corners, small-caps labels, a ledger-style summary with double rules, certificate-style
  panels, a wax seal, and a postmark for the delivery proof.

The theme follows the operating system until you choose. Text contrast is measured in a real browser for every look x theme
(`e2e/appearance.e2e.ts`). When one look is chosen, delete the `looks` group in `src/components/Appearance.tsx`.

## Not done / not verified

- Not tried with a real wallet extension (MetaMask etc.); tested with an EIP-1193 stand-in that signs via the node.
- No Monad network available from the build environment: chain id, RPC, gas behaviour and wallet "add network" are unverified.
- Browser coverage is Chromium only; accessibility is checked for names, keyboard use and no horizontal scroll, not a full audit.
- Funding from other chains (Aurora Intents) is not built; the UI says so.
- Native MON only. ERC-20 / NFT tranches work in the contracts but have no screens yet.
