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
`npm test` (fast unit tests, no network), `npm run typecheck`. A ready GitHub Actions CI
workflow (npm ci, typecheck, tests on Node 24) is in `ci/github-actions-ci.yml`; move it to
`.github/workflows/ci.yml` to turn it on.

### Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `XRPL_NETWORK` | `devnet` | `devnet` (default) or `testnet`. Anything else is refused. |
| `XRPL_WS` | Ripple's public test server for the network | Must be a known test host (allowlist in `src/config.ts`), e.g. `wss://testnet.xrpl-labs.com` or `wss://devnet.xrpl-labs.com` (port 443, useful where 51233 is blocked). Other hosts are refused, and the server must report `network_id` 2 (devnet) or 1 (testnet). |
| `XRPL_FAUCET_HOST` | the network's public faucet | |
| `PORT` / `HOST` | `8790` / `127.0.0.1` | Dashboard server. |
| `DCH_ALLOW_HTTP_RESET` | off | Set `1` to allow the dashboard's Reset button (spends faucet requests). |
| `DCH_DATA_DIR` | `.data` | World state. Holds throwaway test seeds: gitignored, mode 0600, never sent to the browser or printed. |

**Which network?** The default is **devnet**: as of Nov 21 2026 the live check shows every
level's amendments enabled there. Testnet stays selectable with `XRPL_NETWORK=testnet`; there,
levels 6–7 show coming soon. A full devnet run scored 140/140 — see
[docs/SMOKE.md](docs/SMOKE.md).

## How it plays

- **Seats:** issuer, holder, lender, borrower, auditor. Claim one with your name; leave it and a bot takes it back. If a level's seats are all bots, anyone can drive the demo.
- **reset-world:** funds a fresh set of faucet accounts (five seats plus a holder bot), puts bots in every seat, clears scores and recent results, and re-checks amendments. Safe to re-run: the old world is replaced only after all funding succeeds.
- **Scoring:** 10 for a goal, 5 for a correctly rejected should-fail, +5 when both are done. Once per world. Seven scored levels, max 140. Only a *final* rejection counts (validated `tec`, or `tem`/`tef`/`tel`). Timeouts, queued or unvalidated results are *inconclusive*: 0 points, try again. If a should-fail is *accepted*, it scores 0 and is flagged for maintainers.
- **Quiz gate:** after a level's goal and should-fail pass (Level 0: once your seat is linked; Level 8: any time in your world), a 3-question quiz closes the switch, one question per card. 2 of 3 right passes; a wrong answer shows a one-line "here's why" from the level text, and a failed attempt can be retried right away. Answers are checked on the server and never sent to the browser. Questions live in `src/quizzes.ts`.
- **No skipping:** Next stays put on a step you haven't run yet (Run level / Try it) and on an unanswered quiz question; the arrow points at the button or the answer choices instead. A level's end card only offers the next level once its steps and quiz pass; otherwise it sends you back to what's left. A later level opened by URL or an old bookmark shows "Locked" and points at the level to play.
- **Long runs:** the page starts a level run as a background job and polls it every 3 seconds (`POST /api/levels/<id>/<part>` with `"async": true`, then `GET /api/jobs/<id>`), so a phone that locks its screen or drops the connection during Level 7's wait keeps going instead of showing "Load failed".
- **Score:** level points (max 140, as before) plus quiz points: 10 per right answer on your **first** attempt, 9 quizzes x 3 questions = 270. A perfect run is **410**. A retry (after fewer than 2 of 3) can pass the quiz and close the switch, but adds no points, so reading the why lines can't raise your score. Worlds from before quizzes keep their level points and take the quizzes to close their switches again.
- **Graduation:** close every switch and the game opens a graduate screen. Put a display name on your card (up to 32 characters) and the server checks your world, then draws a card: the fully lit circuit with the DCH core powered, the levels the server verified for you (Level 0, every scored level and the Level 8 explainer, each with its quiz passed), your score and the date (UTC). Download the image or press **Share on X**, which opens X with the text filled in; nothing is posted until you press Post. The share link uses a random id, never your address.
- **Amendment gating:** before a level relies on an amendment, the game asks the connected server with the [`feature`](https://xrpl.org/docs/references/http-websocket-apis/admin-api-methods/status-and-debugging-methods/feature) method. If it is not enabled there, the level shows **coming soon** instead of failing. See [Amendments](https://xrpl.org/docs/concepts/networks-and-servers/amendments) and [Known Amendments](https://xrpl.org/resources/known-amendments).

## Levels

| # | Level | Needs | Status |
|---|---|---|---|
| 0 | Get your devnet wallet (onboarding) | none | **guide**, unscored |
| 1 | Issue a token, keep rippling off | core rules | **playable** |
| 2 | Freeze and clawback | Clawback | **playable** |
| 3 | Issue and accept a credential | Credentials | **playable** |
| 4 | Open a permissioned domain | PermissionedDomains + PermissionedDEX | **playable** |
| 5 | Batch: create plus accept | Batch (or BatchV1_1) | **playable** |
| 6 | Deposit in a single-asset vault | SingleAssetVault | **playable** where enabled (devnet), priority |
| 7 | Fund a loan and repay it | SingleAssetVault + LendingProtocol | **playable** where enabled (devnet), priority |
| 8 | Explainer: confidential MPT transfers | ConfidentialTransfer | **priority**, read-only explainer (interactive steps planned) |

### How the UI works

- **Home is a circuit board.** Each level is a switch. Finishing a level closes its switch and
  lights the trace to the next one; the current level pulses and later levels are dim. When
  every switch is closed, the lamp at the end lights up. Levels whose amendment is off on the
  network show "coming soon" and are bypassed. **Map** is in the top bar on every screen.
- **Short step cards.** Each level is a few small cards (one idea each) with big Back / Next
  buttons; ← / → and Enter work too, Esc goes to the map. Deeper text and the xrpl.org links
  sit behind **Learn more**.
- **Guided pointer.** A flashing arrow and a glow ring point at the one thing to press next
  (Start, Generate wallet, Fund from faucet, a seat, Run level, Next…). The hint is announced
  to screen readers and focus moves to the target. With "reduce motion" on, it stays steady.
- **One world per player.** In Level 0 each player makes a wallet in the browser, then presses
  **Start my world**: the server funds a fresh set of test accounts keyed by that wallet's
  address, so seats, scores and the circuit are that player's alone. The server only ever sees
  the address (validated as a classic address), never a seed.
- **What's saved in the browser:** the step you're on per level, which explainers you've read,
  and your wallet *address*. Never a seed. Game progress (scores, seats) comes from your world
  on the server.

### Level 0: get your devnet wallet

A guided, unscored start (the 140-point total is unchanged). It explains what devnet is (free
test XRP with no value; the network can be reset), then the game **creates a wallet in your
browser** with the xrpl.js browser build. The browser calls the public faucet directly with
your address, the dashboard confirms the balance live (`GET /api/account/<address>`, address
only), and you claim a seat with that address, replacing a bot. The seed is shown once with a
clear warning (save it; test-only; never reuse a test seed on mainnet). It is never stored and
never sent to the server: the server refuses any request that contains a seed or a secret-named
field, and never echoes or logs it (see `test/server.test.ts`). In this version, level
transactions for a seat are still signed by the world's server-side test account for that role;
signing from your own wallet is planned. Sources:
[Parallel networks](https://xrpl.org/docs/concepts/networks-and-servers/parallel-networks),
[Faucets](https://xrpl.org/resources/dev-tools/xrp-faucets),
[Accounts](https://xrpl.org/docs/concepts/accounts),
[Reserves](https://xrpl.org/docs/concepts/accounts/reserves),
[Cryptographic keys](https://xrpl.org/docs/concepts/accounts/cryptographic-keys).

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
not on testnet**. Devnet is the default network, so these play out of the box (on testnet they show coming soon).

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

## End-to-end playthrough (run it on your Mac)

`npm run e2e` plays the live game like a phone player: Playwright headless Chromium at iPhone size,
devnet or testnet only (it checks the server first and stops otherwise), no wallet app. It plays
Level 0 through the graduate card, answers the quizzes from a test-only answer key
(`e2e/lib.mjs`, never sent to the browser), and prints PASS/FAIL per level.

Mac, one line (Node 22 or newer; get it from nodejs.org or `brew install node@22`):

```sh
git clone https://github.com/by-AiVibes/dch-tutorial-game.git && cd dch-tutorial-game && npm ci && npx playwright install chromium && npm run e2e -- --url https://game.dch.everhostx.com
```

Already cloned: `cd dch-tutorial-game && git pull && npm ci && npm run e2e -- --url https://game.dch.everhostx.com`

More:

```sh
npm run e2e -- --url https://game.dch.everhostx.com --runs 3     # 3 runs in a row, one world
npm run e2e -- --url https://game.dch.everhostx.com --level 7    # only Level 7 (earlier levels played first if needed)
npm run e2e -- --url https://game.dch.everhostx.com --fresh      # new wallet + world (counts toward 3 per hour)
npm run e2e -- --url https://game.dch.everhostx.com --wrong freeze --headed   # miss one quiz answer, watch it
```

Output in `./e2e-out/`: `report.md` (short and plain: the result, the fails, one line per level;
easy to paste into a chat or a small local model), `report.json` (every step: time, on-screen error,
API route + HTTP status + server error, console errors, screenshot, and a "likely code" hint for
fails) and one screenshot per step. Exit code 0 = all PASS, 1 = a FAIL, 2 = setup problem.

One world per run: the first run makes a test wallet and world and keeps only its **address** in
`./.e2e-player.json`; later runs reuse that world (the server allows 3 new worlds per hour per IP).
Seeds are never written anywhere; reports mask anything seed-shaped. A reused world that already
graduated replays quickly (its levels are done); use `--fresh` for a full new playthrough.

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
src/quizzes.ts      per-level quiz questions, answers and why lines (server-only)
src/jobs.ts         background level runs the page polls (in memory, random ids, 15 min expiry)
src/award.ts        graduation card: SVG, PNG render (resvg), share page with og/twitter tags
assets/fonts/       DejaVu Sans (bundled for the card; license in FONT-LICENSE.txt)
public/             UI (vanilla JS/CSS/SVG): circuit level map, step cards, guided pointer
  mapstate.js       pure map logic (which switches are closed), shared with the tests
test/               fast unit tests
scripts/check-card-scroll.mjs  headless 375px check: card titles stay visible after each Next
scripts/play-through.mjs       headless 375px "real player" (CDP, no deps), used for dogfooding
e2e/play.mjs, e2e/lib.mjs      `npm run e2e`: Playwright playthrough + report (answer key is test-only)
```

See [docs/INSTRUCTOR.md](docs/INSTRUCTOR.md) for running a session and [DEPLOY.md](DEPLOY.md) for hosting notes.
