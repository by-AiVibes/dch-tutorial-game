# Instructor notes

A 45–60 minute session for developers who know basic XRPL concepts (accounts, XRP, transactions).

## Before the session

1. `npm install`. The default network is devnet, where all seven levels play; testnet is
   available with `XRPL_NETWORK=testnet`. Check first with `npm run dch -- amendments`. A level whose
   amendment isn't enabled shows **coming soon**, never an error.
2. `npm run dch -- reset-world` (about 30–60 s: six faucet accounts). If the faucet is busy, the
   command fails cleanly and the previous world stays; run it again in a minute.
3. `npm start` and open the dashboard. On a shared screen, keep `DCH_ALLOW_HTTP_RESET` off.

## Running it

- Start with **Level 0** on the dashboard: everyone creates a devnet wallet in their own browser,
  funds it from the faucet, checks the balance, and claims a seat with it. Stress the warning:
  save the seed, it's test-only, never reuse a test seed on mainnet.

- Each player types a name and claims a seat. Unclaimed seats are bots; if a level's seats are
  all bots, anyone can press the buttons (good for a demo from the front).
- For each level: read the goal aloud, run it, open one transaction in the explorer, then ask
  the room to predict the should-fail result *before* pressing it.
- Points: 10 goal, 5 correct rejection, +5 both. 140 is a perfect world. Cleared parts don't
  re-run; reset the world to replay.

## Talking points per level (with xrpl.org sources)

| Level | Key idea | Expected rejection | Source |
|---|---|---|---|
| 1 Rippling | DefaultRipple on the issuer; NoRipple on holders | `tecPATH_DRY` | [Rippling](https://xrpl.org/docs/concepts/tokens/fungible-tokens/rippling) |
| 2 Freeze/clawback | Clawback must be enabled before the issuer owns objects; `Amount.issuer` is the holder | `tecNO_PERMISSION` | [Clawback](https://xrpl.org/docs/concepts/tokens/fungible-tokens/clawing-back-tokens) |
| 3 Credentials | A credential is in force only after the subject accepts it | `tecNO_ENTRY` | [Credentials](https://xrpl.org/docs/concepts/decentralized-storage/credentials) |
| 4 Domains | Domains list accepted credentials; the permissioned DEX enforces them | `tecNO_PERMISSION` | [Permissioned domains](https://xrpl.org/docs/concepts/tokens/decentralized-exchange/permissioned-domains) |
| 5 Batch | All-or-nothing: the outer Batch can be `tesSUCCESS` while inner txs roll back — check the ledger | (none applied) | [Batch](https://xrpl.org/docs/concepts/transactions/batch-transactions) |
| 6 Vault | Deposits mint shares; withdrawals burn shares | `tecINSUFFICIENT_FUNDS` | [Single asset vaults](https://xrpl.org/docs/concepts/tokens/single-asset-vaults) |
| 7 Lending | Broker on a vault, first-loss capital, co-signed LoanSet; with LendingProtocolV1_1, closed-ended vaults and phases | `tecLIMIT_EXCEEDED` | [Lending protocol](https://xrpl.org/docs/concepts/tokens/lending-protocol) |
| 8 Confidential transfers | Explainer: MPT balances and amounts shielded with EC-ElGamal + ZK proofs; issuers/auditors can still verify supply | — | [Known amendments](https://xrpl.org/resources/known-amendments#confidentialtransfer) |

## How the live ledger fits in

- Every action is a real transaction on a public test network; the dashboard links each hash
  to the explorer, and the objects panel reads live ledger entries (`account_objects`).
- Amendments: the game calls the `feature` method on start of each world and on demand, so the
  room can see which features a network has turned on
  ([Amendments](https://xrpl.org/docs/concepts/networks-and-servers/amendments)).
- Test networks are reset from time to time; old worlds may disappear. `reset-world` makes a new one.

## If something goes wrong

- *Faucet error:* wait and re-run `reset-world`; the old world is kept until the new one is funded.
- *"Claim one of these seats first":* someone holds a seat this step needs; they press it, or leave the seat.
- *Lending says the window passed:* the game builds a fresh closed-ended vault automatically (≈30 s wait).
- *A should-fail is accepted:* it scores 0 and appears under "Flagged" — tell the maintainers.
