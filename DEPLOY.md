# Deploy (stub — not deployed)

Nothing is deployed. Hosting needs an explicit GO.

Plan, for later:

- Runs as a single Node.js 22.18+ process: `npm ci --omit=dev && npm start`. No build step.
- Can run on an EverHostX cluster (one small instance is enough).
- Put it behind HTTPS; bind `HOST=127.0.0.1` and proxy, or set `HOST=0.0.0.0` only behind a proxy.
- Persist `DCH_DATA_DIR` on a volume. It holds throwaway test-network seeds: keep it mode 0700,
  never back it up publicly, never commit it.
- Leave `DCH_ALLOW_HTTP_RESET` off on a public host; run `reset-world` from the shell or a
  scheduled job instead, so visitors can't drain the faucet.
- Outbound access needed: the test network WebSocket (default port 51233, or a 443 endpoint via
  `XRPL_WS`) and the faucet over HTTPS.
- Health check: `GET /api/state` returns 200.
- Level 0: browsers call the public faucet directly and load `/vendor/xrpl.js` (served from
  `node_modules/xrpl/build`, so keep production installs complete). `/api/account/<address>`
  does a ledger lookup per call and needs the same rate limit as the other endpoints.
- App-level limits (second layer behind the proxy): per-IP fixed windows — `read` 120/min,
  `heavy` 12/min (`/api/levels/...`, `/api/objects`, `/api/account/...`, `/api/amendments`),
  `reset` 2/hour per IP and 6/hour globally — answered with 429 + `Retry-After`. At most
  `DCH_MAX_QUEUE` (default 8) ledger operations may wait; more get 503. Tune with
  `DCH_RL_<READ|HEAVY|RESET>_MAX` / `_WINDOW_MS`. Behind a local reverse proxy set
  `TRUST_PROXY=1` so limits use the client IP the proxy appends to `X-Forwarded-For`; keep
  `HOST=127.0.0.1` so only the proxy can reach the app. Node timeouts: headers 10 s,
  request 30 s, keep-alive 5 s.
- Network: devnet by default (`XRPL_NETWORK=devnet`); set `XRPL_NETWORK=testnet` to switch.
  Only allowlisted test hosts are accepted, and the server must report `network_id` 2 or 1;
  mainnet is refused.
