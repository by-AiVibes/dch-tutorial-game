// Small HTTP server: JSON API + static dashboard. No framework.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadConfig } from "./config.ts";
import { Game } from "./game.ts";

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = join(import.meta.dirname, "..", "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
/** reset-world spends faucet requests; allow it over HTTP only when explicitly enabled. */
const ALLOW_HTTP_RESET = process.env.DCH_ALLOW_HTTP_RESET === "1";

const game = new Game(loadConfig(), (m) => console.log(m));

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
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return send(res, 400, { error: "invalid_url" });
  }
  const p = url.pathname;
  if (req.method === "GET" && p === "/api/state") return send(res, 200, game.view());
  if (req.method === "GET" && p === "/api/objects") return send(res, 200, await game.objects());
  if (req.method === "POST" && p.startsWith("/api/")) {
    const b = await body(req);
    const player = typeof b.player === "string" ? b.player : null;
    if (p === "/api/seat/claim") return send(res, 200, game.claim(String(b.role), String(b.player)));
    if (p === "/api/seat/release") return send(res, 200, game.release(String(b.role), String(b.player)));
    if (p === "/api/amendments") return send(res, 200, await game.refreshAmendments());
    if (p === "/api/reset-world") {
      if (!ALLOW_HTTP_RESET) return send(res, 403, { error: "Run `npm run dch -- reset-world`, or start the server with DCH_ALLOW_HTTP_RESET=1." });
      return send(res, 200, await game.resetWorld());
    }
    const m = /^\/api\/levels\/([a-z]+)\/(goal|should-fail)$/.exec(p);
    if (m) return send(res, 200, await game.play(m[1], m[2] === "goal" ? "goal" : "shouldFail", player));
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

createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 400, { error: e instanceof Error ? e.message : String(e) }));
}).listen(PORT, HOST, () => console.log(`DCH tutorial game on http://${HOST}:${PORT} (${game.cfg.name})`));
