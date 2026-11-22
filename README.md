# DCH Tutorial Game

Learn the XRP Ledger by playing short levels on a **test network** (testnet or devnet).
You claim a role seat; bots play the other seats. Each level has a **goal** to complete and a
**should-fail** challenge that scores only when the ledger correctly rejects it.

> Test networks only. No real funds, no mainnet keys. Test accounts come from the public
> faucet at runtime. Facts in the game link to [xrpl.org](https://xrpl.org/docs).

## Quick start

Requires Node.js 22.18+ (runs TypeScript directly; no build step).

```bash
npm install
npm run dch -- reset-world          # fund fresh faucet accounts; bots fill every seat
npm run dch -- play issue goal      # Level 1 goal
npm run dch -- play issue should-fail
npm start                           # dashboard on http://127.0.0.1:8790
```

Other commands: `npm run dch -- amendments` (live amendment check), `npm run dch -- status`,
`npm test` (fast unit tests, no network), `npm run typecheck`.

### Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `XRPL_NETWORK` | `testnet` | `testnet` or `devnet`. Anything else is refused. |
| `XRPL_WS` | Ripple's public test server for the network | Any test-network WebSocket, e.g. `wss://testnet.xrpl-labs.com`. Mainnet URLs and `network_id` 0 are refused. |
| `XRPL_FAUCET_HOST` | the network's public faucet | |
| `PORT` / `HOST` | `8790` / `127.0.0.1` | Dashboard server. |
| `DCH_ALLOW_HTTP_RESET` | off | Set `1` to allow the dashboard's Reset button (spends faucet requests). |
| `DCH_DATA_DIR` | `.data` | World state. Holds throwaway test seeds: gitignored, mode 0600, never sent to the browser or printed. |

## How it plays

- **Seats:** issuer, holder, lender, borrower, auditor. Claim one with your name; leave it and a bot takes it back. If a level's seats are all bots, anyone can drive the demo.
- **reset-world:** funds a fresh set of faucet accounts (five seats plus a holder bot), puts bots in every seat, clears scores and recent results, and re-checks amendments. Safe to re-run: the old world is replaced only after all funding succeeds.
- **Scoring:** 10 for a goal, 5 for a correctly rejected should-fail, +5 when both are done. Once per world. Seven scored levels, max 140. If a should-fail is *accepted*, it scores 0 and is flagged for maintainers.
- **Amendment gating:** before a level relies on an amendment, the game asks the connected server with the [`feature`](https://xrpl.org/docs/references/http-websocket-apis/admin-api-methods/status-and-debugging-methods/feature) method. If it is not enabled there, the level shows **coming soon** instead of failing. See [Amendments](https://xrpl.org/docs/concepts/networks-and-servers/amendments) and [Known Amendments](https://xrpl.org/resources/known-amendments).

## Levels

| # | Level | Needs | Status |
|---|---|---|---|
| 1 | Issue a token, keep rippling off | core rules | **playable** |
| 2 | Freeze and clawback | Clawback | next slice |
| 3 | Issue and accept a credential | Credentials | next slice |
| 4 | Open a permissioned domain | PermissionedDomains | planned |
| 5 | Batch: create plus accept | Batch | next slice |
| 6 | Deposit in a single-asset vault | SingleAssetVault | **priority**, gated |
| 7 | Fund a loan and repay it | SingleAssetVault + LendingProtocol | **priority**, gated |
| 8 | Explainer: confidential MPT transfers | ConfidentialTransfer | **priority**, read-only until enabled |

**Priority for the next slices:** the Single Asset Vault and Lending Protocol levels (6–7) and
the ConfidentialTransfer explainer (8), because these amendments are in voting right now. They
stay "coming soon" on any network where the live check shows them not enabled. Our own code;
the XRPLF XRPL-LendingReference app is used for ideas only.

### Level 1: why rippling stays off for holders

[Rippling](https://xrpl.org/docs/concepts/tokens/fungible-tokens/rippling) moves balances
between two trust lines of the same currency through an account. An **issuer** wants that
(holders pay each other through it), so it sets **DefaultRipple**. A normal **holder** should
not let strangers route payments through its own balances, so its trust lines keep
**NoRipple** set.

- Goal: issuer sets DefaultRipple; holders open TST trust lines with NoRipple; issuer issues
  TST; one holder pays another *through the issuer*. Checked on-ledger.
- Should-fail: a second line makes the holder sit between two TST lines; the issuer tries to
  pay *through the holder*. Expected result: `tecPATH_DRY`.

Smoke run on testnet (world 1, Nov 21 2026):

| Step | Result | Tx |
|---|---|---|
| Issuer AccountSet DefaultRipple | tesSUCCESS | [144F9849…](https://testnet.xrpl.org/transactions/144F98499FB7D6BDD4FB7089C31281F1B9B9DB6DB90ED78FC39EED0EDD5EB3E2) |
| Holder TrustSet NoRipple | tesSUCCESS | [4902868B…](https://testnet.xrpl.org/transactions/4902868B96682D72F52651962235ED6A4BD2120A7695F8AD096F0EDEE2C8C232) |
| Holder→holder via issuer | tesSUCCESS | [D31330FD…](https://testnet.xrpl.org/transactions/D31330FD3BFB94E91B5B557C4D3A9E56A61A182638B908566EB6F526254620B0) |
| Should-fail: route through holder | **tecPATH_DRY** | [9EF4F641…](https://testnet.xrpl.org/transactions/9EF4F641AF4FDB19369EDA3C28E67040F216063621E234042F7C726CD54F048B) |

## Layout

```
src/config.ts       networks + mainnet guards
src/amendments.ts   feature-RPC check and level gating
src/ledger.ts       connect, faucet, submit (never throws on tec/tem)
src/seats.ts        seat claim/release, bot fill
src/scoring.ts      points and should-fail judging
src/store.ts        world state file (secrets stay server-side)
src/game.ts         engine: reset-world, play, serialized operations
src/levels/         level definitions
src/server.ts       JSON API + static dashboard (no framework)
public/             dashboard (vanilla JS)
test/               fast unit tests
```

See [DEPLOY.md](DEPLOY.md) for hosting notes.
