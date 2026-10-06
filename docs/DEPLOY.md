# Deploying Kindred to Monad testnet

You run these steps on your own machine. **Never paste a private key into a chat, an issue, or a commit.** Use an environment
variable, and use a fresh key that only ever holds test funds.

Network details (confirm against Monad's testnet page before relying on them): chain id **10143**,
RPC **https://testnet-rpc.monad.xyz**, currency MON. Faucet: https://faucet.monad.xyz.

## 1. Prepare

```bash
git clone --recurse-submodules https://github.com/AliFikan94/kindred && cd kindred
cd contracts && forge build && forge test && cd ..
export RPC_URL=https://testnet-rpc.monad.xyz
export PRIVATE_KEY=0x...        # a throwaway key funded from the faucet; never commit it
cast chain-id --rpc-url $RPC_URL   # expect 10143
cast balance $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $RPC_URL
```

## 2. Choose a validator (optional, enables "let it grow")

Growing needs one staking validator id that exists on the testnet. Find one on the Monad testnet explorer or staking dashboard,
then pass it below. Without it the app simply hides the growing option.

## 3. Deploy the factory

```bash
cd contracts
MIN_FUNDING_WINDOW=60 MAX_FUNDING_WINDOW=2592000 MAX_TIP=500000000000000000 PREPARE_LEAD=172800 \
FEE_RECIPIENT=<address that receives the 10% share of rewards, or omit> \
VALIDATOR_IDS=<id>   \
forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast
```

Note the printed `ScheduleFactory` address and the block number (`cast block-number --rpc-url $RPC_URL`, or the deployment tx's block).
`PREPARE_LEAD` is how long before a date a staked tranche starts unbonding; staking-time assumptions come from Monad's epoch length,
so check it before relying on 48 hours.

## 4. Run the keeper

```bash
cd ../keeper && npm install && cp .env.example .env
# edit .env: RPC_URL, CHAIN_ID=10143, FACTORY=<address>, FROM_BLOCK=<block>, KEEPER_PRIVATE_KEY=<a second throwaway key with a little MON>
set -a; . ./.env; set +a; npm start
```

## 5. Run the app against it

```bash
cd ../app && npm install && cp .env.example .env.local
# VITE_FACTORY=<address>  VITE_CHAIN_ID=10143  VITE_CHAIN_NAME="Monad Testnet"  VITE_RPC_URL=https://testnet-rpc.monad.xyz
# VITE_FACTORY_BLOCK=<block>  VITE_VALIDATOR_ID=<id or 0>  VITE_EXPLORER=<explorer base url>
# VITE_DEMO=1   (adds "in a few minutes", so a real delivery can be shown in the video)
npm run dev
```

## 6. Record what you ran

Put the factory address and one or two schedule transaction hashes in the root `README.md` (the "Monad integration" table). The
Hackathon asks for contract addresses or transaction hashes, and a demo video that shows Monad interactions.

## Things to expect and report back

This has only ever run against a local node. Things most likely to need adjustment on the real network: gas limits for staked
operations (`GAS_*` in the keeper), the RPC's log-range limit (`LOG_CHUNK`), and wallet "add network" behaviour. If something fails,
send the error text and the transaction hash.
