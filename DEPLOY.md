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
- App-level limits (second layer behind the proxy): per-IP fixed windows, IPv6 bucketed by /64 —
  `read` 120/min, `account` 60/min (`/api/account/...`, Level 0 balance polling), `heavy` 12/min
  (`/api/levels/...`, `/api/objects`, `/api/amendments`), `reset` 2/hour per IP and 6/hour
  globally — answered with 429 + `Retry-After` (also when the 50k-key table is full: expired
  keys are swept first, and the header gives the real wait). Level runs share one queue of
  `DCH_MAX_QUEUE` (default 8); read-only lookups (`/api/account`, `/api/objects`) skip it but
  have their own cap `DCH_MAX_READS` (default 4). Over either cap: 503 + `Retry-After: 5`.
  Node timeouts: headers 10 s, request body 30 s, keep-alive 5 s.
- Workshop tuning (many players behind one NAT): raise `DCH_RL_<READ|ACCOUNT|HEAVY|RESET>_MAX`
  and/or change `_WINDOW_MS`, e.g. `DCH_RL_HEAVY_MAX=120 DCH_RL_ACCOUNT_MAX=600`.
- Reverse proxy: keep `HOST=127.0.0.1` and set `TRUST_PROXY=1`. Proxy headers are honoured only
  when the connection comes from loopback, and only if the value is a valid IP. The proxy must
  set (overwrite) the client IP, e.g. Caddy:

      reverse_proxy 127.0.0.1:8790 {
          header_up X-Real-IP {remote_host}
      }

  (nginx: `proxy_set_header X-Real-IP $remote_addr;` and
  `proxy_set_header X-Forwarded-For $remote_addr;` — overwrite, don't append.)
- Proxy read/response timeout for `/api/levels/` must be at least 180 s (Level 7 waits for the
  vault's investment phase). Don't set a short write timeout on the proxy for this site.
- `DCH_ALLOW_HTTP_RESET` stays off on any public host.
- Network: devnet by default (`XRPL_NETWORK=devnet`); set `XRPL_NETWORK=testnet` to switch.
  Only allowlisted test hosts are accepted, and the server must report `network_id` 2 or 1;
  mainnet is refused.
