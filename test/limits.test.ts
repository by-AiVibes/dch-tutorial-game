import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BusyError, classify, clientIp, QueueGate, RateLimiter, DEFAULT_RULES } from "../src/limits.ts";

test("classify: reset, heavy and read endpoints", () => {
  assert.equal(classify("POST", "/api/reset-world"), "reset");
  for (const p of ["/api/objects", "/api/account/rX", "/api/amendments", "/api/levels/issue/goal"]) assert.equal(classify("GET", p), "heavy", p);
  for (const p of ["/api/state", "/", "/app.js", "/api/seat/claim"]) assert.equal(classify("GET", p), "read", p);
});

test("rate limiter: per-IP windows, reset is limited harder and globally", () => {
  let t = 0;
  const rl = new RateLimiter({ read: { max: 3, windowMs: 1000 }, heavy: { max: 2, windowMs: 1000 }, reset: { max: 1, windowMs: 10_000, globalMax: 2 } }, () => t);
  assert.equal(rl.check("a", "heavy"), 0);
  assert.equal(rl.check("a", "heavy"), 0);
  assert.ok(rl.check("a", "heavy") > 0, "3rd heavy blocked");
  assert.equal(rl.check("b", "heavy"), 0, "other IPs unaffected");
  assert.equal(rl.check("a", "read"), 0, "classes are separate");
  t = 1000;
  assert.equal(rl.check("a", "heavy"), 0, "window resets");
  // reset-world: 1 per IP, 2 across all IPs
  assert.equal(rl.check("a", "reset"), 0);
  assert.ok(rl.check("a", "reset") > 0);
  assert.equal(rl.check("b", "reset"), 0);
  assert.ok(rl.check("c", "reset") > 0, "global reset cap");
  assert.ok(DEFAULT_RULES.reset.max < DEFAULT_RULES.heavy.max && DEFAULT_RULES.reset.windowMs > DEFAULT_RULES.heavy.windowMs);
});

test("rate limiter: memory cap refuses new keys under a flood", () => {
  const rl = new RateLimiter({ read: { max: 5, windowMs: 1000 }, heavy: { max: 5, windowMs: 1000 }, reset: { max: 1, windowMs: 1000 } }, () => 0, 3);
  for (const ip of ["1", "2", "3"]) assert.equal(rl.check(ip, "read"), 0);
  assert.ok(rl.check("4", "read") > 0);
  assert.equal(rl.size, 3);
});

test("queue gate: refuses work beyond max depth", async () => {
  const g = new QueueGate(2);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const a = g.run(() => hold);
  const b = g.run(() => hold);
  await assert.rejects(g.run(async () => 1), BusyError);
  release();
  await Promise.all([a, b]);
  assert.equal(g.depth, 0);
  assert.equal(await g.run(async () => 7), 7);
});

test("client IP: proxy header trusted only when configured", () => {
  assert.equal(clientIp("127.0.0.1", "1.2.3.4, 5.6.7.8", true), "5.6.7.8");
  assert.equal(clientIp("127.0.0.1", "1.2.3.4", false), "127.0.0.1");
  assert.equal(clientIp("9.9.9.9", undefined, true), "9.9.9.9");
});

test("server: 429 with Retry-After once a heavy endpoint is hammered", async () => {
  process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-rl-"));
  const { Game } = await import("../src/game.ts");
  const { createHandler } = await import("../src/server.ts");
  const { loadConfig } = await import("../src/config.ts");
  const game = new Game(loadConfig({}));
  const rl = new RateLimiter({ read: { max: 100, windowMs: 60_000 }, heavy: { max: 3, windowMs: 60_000 }, reset: { max: 1, windowMs: 60_000, globalMax: 1 } });
  const server = createServer(createHandler(game, rl, false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // No world exists, so level runs fail fast (400) without touching the network.
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/levels/issue/goal`, { method: "POST", body: "{}" })).status);
    assert.deepEqual(codes, [400, 400, 400, 429, 429]);
    const r = await fetch(`${base}/api/levels/issue/goal`, { method: "POST", body: "{}" });
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal((await fetch(`${base}/api/state`)).status, 200, "reads still served");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
