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
- Before public hosting, add a rate limit and a queue cap: `/api/objects` and the
  `/api/levels/...` endpoints each trigger ledger requests (and level runs submit transactions);
  today all operations share one in-process queue with no cap.
- Network: devnet by default (`XRPL_NETWORK=devnet`); set `XRPL_NETWORK=testnet` to switch.
  Only allowlisted test hosts are accepted, and the server must report `network_id` 2 or 1;
  mainnet is refused.
