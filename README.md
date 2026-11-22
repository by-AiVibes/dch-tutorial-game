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

Other commands: `npm run dch -- amendments` (live amendment check), `npm run dch -- play-all`
(every playable level in order — the end-to-end smoke), `npm run dch -- status`,
`npm test` (fast unit tests, no network), `npm run typecheck`.

### Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `XRPL_NETWORK` | `testnet` | `testnet` or `devnet`. Anything else is refused. |
| `XRPL_WS` | Ripple's public test server for the network | Any test-network WebSocket, e.g. `wss://testnet.xrpl-labs.com` or `wss://devnet.xrpl-labs.com` (port 443, useful where 51233 is blocked). Mainnet URLs and `network_id` 0 are refused. |
| `XRPL_FAUCET_HOST` | the network's public faucet | |
| `PORT` / `HOST` | `8790` / `127.0.0.1` | Dashboard server. |
| `DCH_ALLOW_HTTP_RESET` | off | Set `1` to allow the dashboard's Reset button (spends faucet requests). |
| `DCH_DATA_DIR` | `.data` | World state. Holds throwaway test seeds: gitignored, mode 0600, never sent to the browser or printed. |

**Which network?** As of Nov 21 2026 the live check shows every level's amendments enabled on
**devnet**; on testnet, levels 6–7 show coming soon. A full devnet run scored 140/140 — see
[docs/SMOKE.md](docs/SMOKE.md).

## How it plays

- **Seats:** issuer, holder, lender, borrower, auditor. Claim one with your name; leave it and a bot takes it back. If a level's seats are all bots, anyone can drive the demo.
- **reset-world:** funds a fresh set of faucet accounts (five seats plus a holder bot), puts bots in every seat, clears scores and recent results, and re-checks amendments. Safe to re-run: the old world is replaced only after all funding succeeds.
- **Scoring:** 10 for a goal, 5 for a correctly rejected should-fail, +5 when both are done. Once per world. Seven scored levels, max 140. If a should-fail is *accepted*, it scores 0 and is flagged for maintainers.
- **Amendment gating:** before a level relies on an amendment, the game asks the connected server with the [`feature`](https://xrpl.org/docs/references/http-websocket-apis/admin-api-methods/status-and-debugging-methods/feature) method. If it is not enabled there, the level shows **coming soon** instead of failing. See [Amendments](https://xrpl.org/docs/concepts/networks-and-servers/amendments) and [Known Amendments](https://xrpl.org/resources/known-amendments).

## Levels

| # | Level | Needs | Status |
|---|---|---|---|
| 1 | Issue a token, keep rippling off | core rules | **playable** |
| 2 | Freeze and clawback | Clawback | **playable** |
| 3 | Issue and accept a credential | Credentials | **playable** |
| 4 | Open a permissioned domain | PermissionedDomains + PermissionedDEX | **playable** |
| 5 | Batch: create plus accept | Batch (or BatchV1_1) | **playable** |
| 6 | Deposit in a single-asset vault | SingleAssetVault | **playable** where enabled (devnet), priority |
| 7 | Fund a loan and repay it | SingleAssetVault + LendingProtocol | **playable** where enabled (devnet), priority |
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

### Levels 2–5 (testnet smoke, world 1, Nov 21 2026)

- **Freeze and clawback.** Clawback has to be enabled while the issuer owns no ledger objects
  ([docs](https://xrpl.org/docs/concepts/tokens/fungible-tokens/clawing-back-tokens)), so a
  fresh `clawIssuer` is funded the first time the level runs. In a Clawback, `Amount.issuer` is
  the *holder*. Goal: enable → trust → issue 50 CLW → freeze → claw back
  ([Clawback 7F6D25C9…](https://testnet.xrpl.org/transactions/7F6D25C97D637F321A56E4C3F48E555EB34A9996A65D329CC3FBC3BBEE733B74)).
  Should-fail: the Level 1 issuer never enabled clawback →
  [`tecNO_PERMISSION`](https://testnet.xrpl.org/transactions/DCC5AE6160D0AAD29219808D0D824D4FB5F7113C169A852143E42C24165E0071).
- **Credentials.** Issuer creates `DCH-KYC` for the holder; it is not in force until the holder
  accepts it ([docs](https://xrpl.org/docs/concepts/decentralized-storage/credentials)).
  [Create 9EDBDF8F…](https://testnet.xrpl.org/transactions/9EDBDF8F26A630036C554D8D84FC4505F552E0134F7B81CA649299890AAF1F0C),
  [Accept 45052933…](https://testnet.xrpl.org/transactions/45052933A3F433C64F79651F9DDD365B9321B3442114629DDB2C58139F0118F2).
  Should-fail: the holder bot accepts a credential not issued to it →
  [`tecNO_ENTRY`](https://testnet.xrpl.org/transactions/D16E059F6E595B7886783B643CFE859AAE33736B4C255423A299B1195806DF40).
- **Batch.** One all-or-nothing Batch from the issuer, co-signed by the holder bot (a
  `BatchSigner`): create + accept land together
  ([D7750160…](https://testnet.xrpl.org/transactions/D775016051978F7CB34202C1BB4F4BBDA076BA7F4ED5D3D09CB49B5013F5DD51)).
  Should-fail: the accept names a type that was never created, so the create is rolled back too.
  The outer Batch is still `tesSUCCESS` (it pays the fee), so the game checks the ledger to
  confirm nothing landed
  ([86984A06…](https://testnet.xrpl.org/transactions/86984A06F95A6F651ED3C50EBB92167D7727704EAEA6848E4FBA1D8275EAA224)).

- **Permissioned domain.** The issuer creates a domain that accepts its `DCH-KYC` credential;
  the credentialed holder places an offer in that domain's DEX
  ([OfferCreate B5B61950…](https://testnet.xrpl.org/transactions/B5B6195055E18E450A870E240CC3901702001CD5DE9505038FF3BA05D8B7969E)).
  Should-fail: the holder bot has no `DCH-KYC` credential →
  [`tecNO_PERMISSION`](https://testnet.xrpl.org/transactions/E2F8CE8C8431284CAE4F76DDE90A8CDACF6F3F622E7D44C1542512A9E1B9F210).

The dashboard also lists the world's live ledger objects (credentials, domains, vaults, loan
brokers, loans, offers, trust lines) read with `account_objects`.

Goals and should-fails score once per world; re-running a cleared part says so instead of
sending transactions.

### Levels 6 and 7: vault and lending (devnet smoke, world 1, Nov 21 2026)

On Nov 21 2026 the live check showed SingleAssetVault and LendingProtocol **enabled on devnet,
not on testnet**, so run these with `XRPL_NETWORK=devnet` (on testnet they show coming soon).

- **Vault.** The lender opens an XRP vault; the holder deposits 10 XRP and the holder bot 5 XRP
  (each gets vault shares); the holder withdraws its 10 XRP; the vault keeps 5 XRP
  ([withdraw EDA3F2AB…](https://devnet.xrpl.org/transactions/EDA3F2AB83BE80AE384DFAECCEF34A5FB1DB59977CBD30ABC56264ED990FE351)).
  Should-fail: the borrower holds no shares and tries to withdraw →
  [`tecINSUFFICIENT_FUNDS`](https://devnet.xrpl.org/transactions/4816B207E0B3A2CC892D2081525B282FA93D7A64AF1D054614564C7E65BA8927).
- **Lending.** With **LendingProtocolV1_1** enabled (checked live), a new loan broker can only
  attach to a **closed-ended** vault, and loans can only start in its Investment phase, with the
  final payment at least 60 s before redemption
  ([LoanSet docs](https://xrpl.org/docs/references/protocol/transactions/types/loanset)). The
  game creates a closed-ended vault (30 s subscription, 240 s term), deposits 40 XRP, opens a
  broker (debt max 20 XRP), posts 2 XRP first-loss capital, waits for the investment phase, then
  lender and borrower **co-sign** a 10 XRP loan
  ([LoanSet 078BAFFF…](https://devnet.xrpl.org/transactions/078BAFFF9433FBCD42706BB8F8A5E17BE0DE2A1C7A115C695F1DFA4088C19645))
  and the borrower repays it
  ([LoanPay 297FC2A5…](https://devnet.xrpl.org/transactions/297FC2A56DD7238F773F911FA56D1A2238277FC9EA2CB99C79468CDBA1FF3ACD)).
  On networks without V1_1 it uses an open vault. Should-fail: a 25 XRP loan above the debt
  maximum →
  [`tecLIMIT_EXCEEDED`](https://devnet.xrpl.org/transactions/CEE4DAA31F07F4428230153DB868FDB5D3870BFBCDF43159AA4858D373A3186A).

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
