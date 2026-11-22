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
- One world per player: `POST /api/world/start {world: <classic address>}` funds 6 faucet
  accounts for that player (same path as reset-world) and stores the world at
  `$DCH_DATA_DIR/players/<network>-<address>.json` (0600). `/api/state`, `/api/objects` take
  `?world=`; seat and level calls take `world` in the body. Only validated classic addresses
  are accepted as keys; seeds are refused before anything else.
  - Per IP: the `world` class, 3 starts/hour (`DCH_RL_WORLD_MAX`) → 429 + `Retry-After`.
  - Server-wide: `DCH_MAX_NEW_WORLDS_PER_HOUR` (default 30) → 429 + `Retry-After`.
  - Stored worlds: `DCH_MAX_WORLDS` (default 100). The least-recently-used world idle for at
    least `DCH_WORLD_MIN_IDLE_MS` (default 1 h) is evicted; if none is idle → 503 + `Retry-After`.
  - `DCH_SHARED_WORLD_HTTP=0` closes the shared (instructor/CLI) world to HTTP seat and level
    calls; set it on public hosts.
  - Faucet: every world costs 6 faucet requests from the server's IP (plus extra accounts some
    levels add, e.g. Level 2's clawback issuer). Public faucets rate-limit per IP, so a burst of
    new players can see "faucet failed, try again in a minute".
- Graduation award: `POST /api/award {world, name}` checks on the server that the player's own
  world has Level 0 (a seat linked to their address) and both parts of every scored level that
  is live on this network, then returns a card with a random 24-character id. The card record
  and its cached PNG live in `$DCH_DATA_DIR/awards/` (0600; not removed when an idle world is
  evicted, so share links keep working). `GET /award/<id>` is the share page (Open Graph +
  `twitter:card=summary_large_image`); `GET /award/<id>.png` is the 1200x675 image, rendered
  once with `@resvg/resvg-js` and the bundled DejaVu Sans font (no system fonts needed).
  - `DCH_PUBLIC_URL` (for example `https://game.example.org`) is the game's public base URL.
    It is required for link previews: it sets the absolute `og:url`/`og:image` and is the only
    host printed in the card footer. If it is unset, the share page uses the request `Host` only
    when `TRUST_PROXY=1` and the host is listed in `DCH_PUBLIC_HOSTS` (comma-separated);
    otherwise the absolute URLs and the card footer are left out.
  - The card lists exactly the levels the server required and verified for that award: Level 0,
    every scored level live on the network, and the Level 8 explainer, each with its quiz passed
    (quizzes are checked on the server, so Level 8 counts).
- Quizzes: `POST /api/quiz/answer {world, level, q, choice}` and `POST /api/quiz/retry {world, level}`.
  Answers never leave the server. Rate limit class `quiz`: 30/min per IP (`DCH_RL_QUIZ_MAX`).
  - `DCH_MAX_AWARDS` (default 2000) → 503 when full. Rate limits: `award` class 10/hour per IP
    (`DCH_RL_AWARD_MAX`), `awardview` 60/min per IP and 600/min server-wide.
  - CSP stays self-only: the card is a same-origin PNG; the share page has no scripts or inline
    styles. "Share on X" is a plain link to `x.com/intent/post`; the game never posts.
- Network: devnet by default (`XRPL_NETWORK=devnet`); set `XRPL_NETWORK=testnet` to switch.
  Only allowlisted test hosts are accepted, and the server must report `network_id` 2 or 1;
  mainnet is refused.
