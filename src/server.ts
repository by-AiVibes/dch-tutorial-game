// Small HTTP server: JSON API + static dashboard. No framework.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { Game } from "./game.ts";
import { AWARD_ID_RE, awardHtml, awardPng, loadAward } from "./award.ts";
import { assertNoSecrets, cleanAddress } from "./secrets.ts";
import { BusyError, CapError, classify, clientIp, RateLimiter, rulesFromEnv } from "./limits.ts";

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = join(import.meta.dirname, "..", "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
/** reset-world spends faucet requests; allow it over HTTP only when explicitly enabled. */
const ALLOW_HTTP_RESET = process.env.DCH_ALLOW_HTTP_RESET === "1";
/** Seats and level runs in the SHARED world over HTTP. Set 0 on public hosts (players use their own worlds). */
const SHARED_WORLD_HTTP = () => process.env.DCH_SHARED_WORLD_HTTP !== "0";

function sendBusy(res: ServerResponse, message: string) {
  res.writeHead(503, { "content-type": "application/json", "retry-after": "5", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: message, retryAfterSeconds: 5 }));
}

function sendCap(res: ServerResponse, e: CapError) {
  res.writeHead(e.status, { "content-type": "application/json", "retry-after": String(e.retryAfter), "cache-control": "no-store" });
  res.end(JSON.stringify({ error: e.message, retryAfterSeconds: e.retryAfter }));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error("body too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("invalid JSON body"); // generic: never echo body text (it could hold a secret)
  }
}

/** The browser bundle of xrpl.js, so Level 0 can make a wallet locally (seed stays in the browser). */
const VENDOR: Record<string, string> = {
  "/vendor/xrpl.js": join(import.meta.dirname, "..", "node_modules", "xrpl", "build", "xrpl-latest-min.js"),
};

export function createHandler(game: Game, limiter = new RateLimiter(rulesFromEnv()), trustProxy = process.env.TRUST_PROXY === "1") {
  return (req: IncomingMessage, res: ServerResponse) => {
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      /* handled as invalid_url below */
    }
    const ip = clientIp(req.socket.remoteAddress, { "x-real-ip": req.headers["x-real-ip"], "x-forwarded-for": req.headers["x-forwarded-for"] }, trustProxy);
    const wait = limiter.check(ip, classify(req.method ?? "GET", path));
    if (wait > 0) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(wait), "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "rate_limited", retryAfterSeconds: wait }));
    }
    handle(game, req, res).catch((e) =>
      e instanceof BusyError ? sendBusy(res, e.message) : e instanceof CapError ? sendCap(res, e) : send(res, 400, { error: e instanceof Error ? e.message : String(e) }),
    );
  };
}

async function handle(game: Game, req: IncomingMessage, res: ServerResponse) {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return send(res, 400, { error: "invalid_url" });
  }
  const p = url.pathname;
  // ?world=<classic address> selects the player's own world; absent = the shared world.
  const qWorld = () => {
    const w = url.searchParams.get("world");
    if (w) assertNoSecrets(w);
    return Game.key(w);
  };
  // With the shared world off over HTTP, no ?world means a blank view, never the shared world.
  if (req.method === "GET" && p === "/api/state") {
    const k = qWorld();
    return send(res, 200, k === null && !SHARED_WORLD_HTTP() ? game.blankView() : game.view(k));
  }
  if (req.method === "GET" && p === "/api/objects") {
    const k = qWorld();
    return send(res, 200, k === null && !SHARED_WORLD_HTTP() ? { network: game.cfg.name, world: 0, objects: [] } : await game.objects(k));
  }
  const acct = /^\/api\/account\/([^/]+)$/.exec(p);
  if (req.method === "GET" && acct) {
    assertNoSecrets(decodeURIComponent(acct[1]));
    return send(res, 200, await game.account(cleanAddress(decodeURIComponent(acct[1]))));
  }
  // Graduation award share page and image (looked up by random id; the address never appears).
  const aw = /^\/award\/([A-Za-z0-9_-]{24})(\.png)?$/.exec(p);
  if (req.method === "GET" && aw && AWARD_ID_RE.test(aw[1])) {
    const rec = loadAward(aw[1]);
    if (!rec) return send(res, 404, { error: "not_found" });
    if (aw[2]) {
      const png = awardPng(rec);
      res.writeHead(200, { "content-type": "image/png", "content-length": String(png.length), "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" });
      return res.end(png);
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" });
    return res.end(awardHtml(rec));
  }
  if (req.method === "GET" && VENDOR[p]) {
    let data: Buffer;
    try {
      data = await readFile(VENDOR[p]);
    } catch {
      return send(res, 500, { error: "vendor_missing" }); // never echo the file path
    }
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=3600" });
    return res.end(data);
  }
  if (req.method === "POST" && p.startsWith("/api/")) {
    const b = await body(req);
    assertNoSecrets(b); // before anything else touches or logs the body
    const player = typeof b.player === "string" ? b.player : null;
    if (p === "/api/world/start") return send(res, 200, await game.startWorld(b.world, b.fresh === true));
    if (p === "/api/award") return send(res, 200, await game.graduate(b.world, b.name));
    const key = Game.key(b.world);
    const sharedOk = key !== null || SHARED_WORLD_HTTP();
    const sharedOff = () => send(res, 403, { error: "This server runs one world per player: start your world in Level 0." });
    if (p === "/api/seat/claim") return sharedOk ? send(res, 200, game.claim(String(b.role), String(b.player), b.wallet == null || b.wallet === "" ? null : cleanAddress(b.wallet), key)) : sharedOff();
    if (p === "/api/seat/release") return sharedOk ? send(res, 200, game.release(String(b.role), String(b.player), key)) : sharedOff();
    if (p === "/api/amendments") return send(res, 200, await game.refreshAmendments());
    if (p === "/api/reset-world") {
      if (!ALLOW_HTTP_RESET) return send(res, 403, { error: "Run `npm run dch -- reset-world`, or start the server with DCH_ALLOW_HTTP_RESET=1." });
      return send(res, 200, await game.resetWorld());
    }
    const m = /^\/api\/levels\/([a-z]+)\/(goal|should-fail)$/.exec(p);
    if (m) return sharedOk ? send(res, 200, await game.play(m[1], m[2] === "goal" ? "goal" : "shouldFail", player, key)) : sharedOff();
    return send(res, 404, { error: "not_found" });
  }
  if (req.method === "GET") {
    const rel = normalize(p === "/" ? "/index.html" : p).replace(/^(\.\.[/\\])+/, "");
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 404, { error: "not_found" });
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      return res.end(data);
    } catch {
      return send(res, 404, { error: "not_found" });
    }
  }
  send(res, 405, { error: "method_not_allowed" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const game = new Game(loadConfig(), (m) => console.log(m));
  const server = createServer(createHandler(game));
  // Slowloris / idle-connection protection (the proxy has its own timeouts too).
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.listen(PORT, HOST, () => console.log(`DCH tutorial game on http://${HOST}:${PORT} (${game.cfg.name})`));
}
