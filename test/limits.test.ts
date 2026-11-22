import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BusyError, classify, clientIp, ipKey, QueueGate, RateLimiter, DEFAULT_RULES, type LimitClass, type LimitRule } from "../src/limits.ts";

const rules = (o: Partial<Record<LimitClass, LimitRule>> = {}): Record<LimitClass, LimitRule> => ({
  read: { max: 3, windowMs: 1000 },
  account: { max: 5, windowMs: 1000 },
  heavy: { max: 2, windowMs: 1000 },
  reset: { max: 1, windowMs: 10_000, globalMax: 2 },
  world: { max: 2, windowMs: 10_000 },
  ...o,
});

test("classify: reset, account, heavy and read endpoints", () => {
  assert.equal(classify("POST", "/api/reset-world"), "reset");
  assert.equal(classify("GET", "/api/account/rX"), "account");
  for (const p of ["/api/objects", "/api/amendments", "/api/levels/issue/goal"]) assert.equal(classify("GET", p), "heavy", p);
  for (const p of ["/api/state", "/", "/app.js", "/api/seat/claim"]) assert.equal(classify("GET", p), "read", p);
  assert.ok(DEFAULT_RULES.account.max > DEFAULT_RULES.heavy.max, "Level 0 polling gets more room");
});

test("rate limiter: per-IP windows, reset limited harder and globally", () => {
  let t = 0;
  const rl = new RateLimiter(rules(), () => t);
  assert.equal(rl.check("1.1.1.1", "heavy"), 0);
  assert.equal(rl.check("1.1.1.1", "heavy"), 0);
  assert.ok(rl.check("1.1.1.1", "heavy") > 0, "3rd heavy blocked");
  assert.equal(rl.check("2.2.2.2", "heavy"), 0, "other IPs unaffected");
  assert.equal(rl.check("1.1.1.1", "read"), 0, "classes are separate");
  t = 1000;
  assert.equal(rl.check("1.1.1.1", "heavy"), 0, "window resets");
  assert.equal(rl.check("1.1.1.1", "reset"), 0);
  assert.ok(rl.check("1.1.1.1", "reset") > 0);
  assert.equal(rl.check("2.2.2.2", "reset"), 0);
  assert.ok(rl.check("3.3.3.3", "reset") > 0, "global reset cap");
});

test("flood: a full table frees up after the class's OWN window, and Retry-After matches", () => {
  let t = 0;
  // read window 60 s; reset window 1 h. The read table must not be held for an hour.
  const rl = new RateLimiter(rules({ read: { max: 5, windowMs: 60_000 }, reset: { max: 1, windowMs: 3_600_000 } }), () => t, 3);
  for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) assert.equal(rl.check(ip, "read"), 0);
  rl.check("10.0.0.1", "reset"); // a long-window entry in another class
  t = 20_000;
  const wait = rl.check("10.0.0.4", "read");
  assert.equal(wait, 40, "refused with the real wait (60 s window - 20 s elapsed)");
  t = 60_000;
  assert.equal(rl.check("10.0.0.4", "read"), 0, "admitted as soon as the read window passes");
  assert.ok(rl.size("read") <= 3);
});

test("ipKey: IPv6 bucketed by /64, v4-mapped unwrapped, junk is short", () => {
  assert.equal(ipKey("2001:db8:1:2:aaaa::1"), ipKey("2001:db8:1:2:ffff:1:2:3"));
  assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
  assert.equal(ipKey("::ffff:9.9.9.9"), "9.9.9.9");
  assert.equal(ipKey("x".repeat(5000)), "unknown");
  let t = 0;
  const rl = new RateLimiter(rules(), () => t);
  rl.check("2001:db8:1:2::1", "heavy");
  rl.check("2001:db8:1:2::2", "heavy");
  assert.ok(rl.check("2001:db8:1:2::3", "heavy") > 0, "same /64 shares a budget");
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
});

test("client IP: proxy headers only from a loopback peer, validated", () => {
  const h = { "x-forwarded-for": "1.2.3.4, 5.6.7.8" };
  assert.equal(clientIp("127.0.0.1", h, true), "5.6.7.8");
  assert.equal(clientIp("::1", { "x-real-ip": "8.8.4.4" }, true), "8.8.4.4");
  assert.equal(clientIp("::ffff:127.0.0.1", { "x-real-ip": "8.8.4.4" }, true), "8.8.4.4");
  assert.equal(clientIp("203.0.113.9", h, true), "203.0.113.9", "non-loopback peer: header ignored");
  assert.equal(clientIp("127.0.0.1", h, false), "127.0.0.1", "TRUST_PROXY off");
  assert.equal(clientIp("127.0.0.1", { "x-real-ip": "not-an-ip", "x-forwarded-for": "evil" }, true), "127.0.0.1", "invalid values fall back");
});

async function withServer(fn: (base: string, game: any) => Promise<void>, rl?: RateLimiter) {
  process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-rl-"));
  const { Game } = await import("../src/game.ts");
  const { createHandler } = await import("../src/server.ts");
  const { loadConfig } = await import("../src/config.ts");
  const game = new Game(loadConfig({}));
  const server = createServer(createHandler(game, rl ?? new RateLimiter(rules({ read: { max: 100, windowMs: 60_000 }, heavy: { max: 3, windowMs: 60_000 } })), false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, game);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("server: 429 with Retry-After once a heavy endpoint is hammered", async () => {
  await withServer(async (base) => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/levels/issue/goal`, { method: "POST", body: "{}" })).status);
    assert.deepEqual(codes, [400, 400, 400, 429, 429]);
    const r = await fetch(`${base}/api/levels/issue/goal`, { method: "POST", body: "{}" });
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal((await fetch(`${base}/api/state`)).status, 200, "reads still served");
  });
});

test("server: queue full -> 503 with Retry-After 5", async () => {
  process.env.DCH_MAX_QUEUE = "1";
  try {
    await withServer(async (base, game) => {
      // Occupy the single level-queue slot with a never-settling task, then ask for more.
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const busy = (game as any).exclusive(null, () => hold);
      const r = await fetch(`${base}/api/levels/issue/goal`, { method: "POST", body: "{}" });
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("retry-after"), "5");
      release();
      await busy;
    });
  } finally {
    delete process.env.DCH_MAX_QUEUE;
  }
});
