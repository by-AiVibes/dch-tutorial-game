// Visitor and player counters: once per world, eviction-proof file, testers excluded, daily
// visitor hashing (no IPs on disk), backfill, token-gated /api/stats, CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as FS from "node:fs";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
const require_fs = () => FS;
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Wallet } from "xrpl";

const DIR = mkdtempSync(join(tmpdir(), "dch-stats-"));
process.env.DCH_DATA_DIR = DIR;
const { Game } = await import("../src/game.ts");
const { createHandler, statsAuthorized } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");
const { RateLimiter, DEFAULT_RULES } = await import("../src/limits.ts");
const { SCORED_LEVELS, findLevel } = await import("../src/levels/index.ts");
const { deleteWorld, publicView } = await import("../src/store.ts");
const { QUIZZES } = await import("../src/quizzes.ts");
const { Stats, parseIgnoreIps, formatStats } = await import("../src/stats.ts");

const statsFile = join(DIR, "stats.json");
function fakeGame(stats = new Stats(statsFile, { network: "devnet", flushMs: 0 })) {
  const g = new Game(loadConfig({}), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 100, maxAwards: 100 });
  const any = g as any;
  any.ledger = async () => ({});
  any.fundAccounts = async () => Object.fromEntries(["issuer", "holder", "lender", "borrower", "auditor", "holderBot"].map((k) => { const w = Wallet.generate(); return [k, { address: w.address, seed: w.seed }]; }));
  any.shared.amendments = { network: "devnet", checkedAt: new Date(0).toISOString(), amendments: {} };
  any.levelAvailable = () => true;
  g.stats = stats;
  return { g, any, stats };
}
const right = (id: string, i: number) => QUIZZES[id][i].answer;
const wrong = (id: string, i: number) => (QUIZZES[id][i].answer + 1) % QUIZZES[id][i].choices.length;
async function quiz(g: any, a: string, id: string, pattern: boolean[]) {
  for (const [i, ok] of pattern.entries()) await g.answerQuiz(id, i, ok ? right(id, i) : wrong(id, i), a);
}
async function graduate(g: any, any: any, a: string) {
  const w = any.st(a);
  if (!Object.values(w.seats).some((x: any) => x.wallet === a)) g.claim("issuer", "you", a, a);
  for (const l of SCORED_LEVELS) w.scores[l.id] = { goal: true, shouldFail: true };
  any.persist(w);
  for (const id of Object.keys(QUIZZES)) if (!w.quizzes?.[id]?.passed) await quiz(g, a, id, [true, true, true]);
  return g.graduate(a, "Ada");
}

test("player events count once per world, per day and lifetime", async () => {
  const { g, any, stats } = fakeGame(new Stats(join(DIR, "s1.json"), { network: "devnet", flushMs: 0 }));
  const a = Wallet.generate().address;
  await g.startWorld(a);
  await g.startWorld(a); // resume: not a new world
  g.claim("issuer", "you", a, a);
  g.release("issuer", "you", a);
  g.claim("issuer", "you", a, a); // re-link: Level 0 still counted once
  await quiz(g, a, "wallet", [true, false, false]); // first try: 10 pts, failed
  await g.answerQuiz("wallet", 0, 0, a).catch(() => {}); // over: needs Try again
  any.st(a).quizzes.wallet = { answers: [], passed: false, points: 10, attempts: 2 }; // what Try again does
  await quiz(g, a, "wallet", [true, true, true]); // passes, adds no first-try sample
  const L = stats.data.lifetime;
  assert.equal(L.worldsStarted, 1);
  assert.deepEqual(L.levelsCompleted, { wallet: 1 });
  assert.deepEqual(L.quizzesPassed, { wallet: 1 });
  assert.deepEqual(L.quizFirstTry, { wallet: { points: 10, attempts: 1 } });
  const r = await graduate(g, any, a);
  await g.graduate(a, "Ada Renamed"); // same award: not a second graduate
  assert.ok(r.id);
  assert.equal(stats.data.lifetime.graduates, 1);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(stats.data.days[today].graduates, 1);
  assert.equal(stats.data.days[today].worldsStarted, 1);
  // A fresh restart is a new world: counted again.
  await g.startWorld(a, true);
  assert.equal(stats.data.lifetime.worldsStarted, 2);
  // Counting marks never reach the browser.
  assert.equal("statsCounted" in publicView(any.st(a)), false);
});

test("level steps: counted when goal and should-fail are both done", async () => {
  const { g, any, stats } = fakeGame(new Stats(join(DIR, "s2.json"), { network: "devnet", flushMs: 0 }));
  const lv: any = findLevel("issue");
  const saved = { g: lv.runGoal, s: lv.runShouldFail };
  lv.runGoal = async () => ({ ok: true, message: "ok", results: [] });
  lv.runShouldFail = async () => ({ ok: true, message: "", results: [], attempt: { engineResult: "tecNO_AUTH", validated: true, hash: "H" }, verdict: { verdict: "rejected", label: "tecNO_AUTH" } });
  try {
    const a = Wallet.generate().address;
    await g.startWorld(a);
    for (const role of new Set([...lv.goalRoles, ...lv.shouldFailRoles])) g.claim(role, "you", role === lv.goalRoles[0] ? a : null, a);
    await g.play("issue", "goal", "you", a);
    assert.equal(stats.data.lifetime.levelsCompleted.issue, undefined, "goal alone isn't the level");
    await g.play("issue", "shouldFail", "you", a);
    await g.play("issue", "shouldFail", "you", a); // already cleared
    assert.equal(stats.data.lifetime.levelsCompleted.issue, 1);
  } finally { lv.runGoal = saved.g; lv.runShouldFail = saved.s; }
});

test("counts survive world eviction; the file is written atomically (no temp left)", async () => {
  const path = join(DIR, "s3.json");
  const { g } = fakeGame(new Stats(path, { network: "devnet", flushMs: 0 }));
  const a = Wallet.generate().address;
  await g.startWorld(a);
  deleteWorld("devnet", a);
  const again = new Stats(path, { network: "devnet" });
  assert.equal(again.data.lifetime.worldsStarted, 1);
  assert.deepEqual(readdirSync(DIR).filter((f) => f.endsWith(".tmp")), []);
  assert.equal((await import("node:fs")).statSync(path).mode & 0o777, 0o600);
});

test("testers: worlds started from an ignored IP or the e2e user agent are never counted", async () => {
  const s = new Stats(join(DIR, "s4.json"), { network: "devnet", flushMs: 0, ignoreIps: "203.0.113.0/24, 2001:db8::1" });
  assert.equal(s.isIgnored("203.0.113.77", "Safari"), true);
  assert.equal(s.isIgnored("::ffff:203.0.113.5", ""), true);
  assert.equal(s.isIgnored("2001:db8::1", ""), true);
  assert.equal(s.isIgnored("198.51.100.1", "Mozilla/5.0 Safari/604.1 DCH-e2e"), true);
  assert.equal(s.isIgnored("198.51.100.1", "Mozilla/5.0 Safari/604.1"), false);
  const { g, any } = fakeGame(s);
  const a = Wallet.generate().address;
  await g.startWorld(a, false, { statsIgnore: true });
  g.claim("issuer", "you", a, a);
  await quiz(g, a, "wallet", [true, true, true]);
  assert.equal(any.st(a).statsIgnore, true);
  assert.equal(s.data.lifetime.worldsStarted, 0);
  assert.deepEqual(s.data.lifetime.quizzesPassed, {});
  s.visit("203.0.113.9", "Safari");
  assert.equal(s.data.lifetime.pageViews, 0);
  assert.equal(parseIgnoreIps("10.0.0.0/8")("10.2.3.4"), true);
  assert.equal(parseIgnoreIps("10.0.0.0/8")("11.2.3.4"), false);
});

test("visitors: unique per UTC day by rotating HMAC; no IP is written", () => {
  let t = Date.parse("2026-11-22T10:00:00Z");
  const path = join(DIR, "s5.json");
  const s = new Stats(path, { network: "devnet", flushMs: 0, now: () => t });
  s.visit("198.51.100.7", "Safari");
  s.visit("198.51.100.7", "Safari");
  s.visit("198.51.100.8", "Safari");
  t = Date.parse("2026-11-23T00:00:01Z");
  s.visit("198.51.100.7", "Safari"); // new day, new key: counted again that day
  assert.deepEqual([s.data.days["2026-11-22"].visitors, s.data.days["2026-11-22"].pageViews], [2, 3]);
  assert.deepEqual([s.data.days["2026-11-23"].visitors, s.data.days["2026-11-23"].pageViews], [1, 1]);
  assert.deepEqual([s.data.lifetime.visitors, s.data.lifetime.pageViews], [3, 4]);
  const raw = readFileSync(path, "utf8");
  assert.doesNotMatch(raw, /198\.51\.100|[0-9a-f]{16}/, "no IPs or visitor hashes on disk");
});

test("backfill: once, from existing worlds and award cards (evicted graduates too)", async () => {
  // Worlds created before stats existed.
  const { g: pre, any: preAny } = fakeGame(null as any);
  pre.stats = null;
  const a = Wallet.generate().address, b = Wallet.generate().address, c = Wallet.generate().address;
  for (const x of [a, b, c]) await pre.startWorld(x);
  pre.claim("issuer", "you", a, a);
  await quiz(pre, a, "wallet", [true, true, false]);
  await graduate(pre, preAny, b);
  await graduate(pre, preAny, c);
  deleteWorld("devnet", c); // evicted graduate: only the award card is left
  const path = join(DIR, "s6.json");
  const { g, stats } = fakeGame(new Stats(path, { network: "devnet", flushMs: 0 }));
  const before = stats.data.lifetime.worldsStarted;
  const bf = g.backfillStats();
  assert.ok(bf && bf.worlds >= 2);
  const L = stats.data.lifetime;
  assert.ok(L.worldsStarted - before >= 2);
  assert.ok(L.graduates >= 2, "the evicted graduate still counts via its award card");
  assert.ok((L.quizzesPassed.wallet ?? 0) >= 2);
  assert.ok((L.levelsCompleted.issue ?? 0) >= 1);
  assert.equal(g.backfillStats(), null, "one time only");
  const snap = JSON.stringify(stats.data.lifetime);
  // Later events on backfilled worlds don't double count.
  g.release("issuer", "you", a); g.claim("issuer", "you", a, a);
  await g.graduate(b, "Bea");
  assert.equal(JSON.stringify(stats.data.lifetime), snap);
});

test("/api/stats: 404 without the right bearer token, counts with it; only game page loads are page views", async () => {
  process.env.DCH_STATS_TOKEN = "t0ken-for-tests-0123456789";
  const { g } = fakeGame(new Stats(join(DIR, "s7.json"), { network: "devnet", flushMs: 0 }));
  const srv = createServer(createHandler(g, new RateLimiter(DEFAULT_RULES), false));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fetch(`${base}/`); await fetch(`${base}/`, { headers: { "user-agent": "x DCH-e2e" } });
    await fetch(`${base}/app.js`); // assets aren't page views
    for (const h of [{} as Record<string, string>, { authorization: "Bearer wrong-token-wrong-token" }, { authorization: "Basic abc" }]) {
      const r = await fetch(`${base}/api/stats`, { headers: h });
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: "not_found" });
    }
    const r = await fetch(`${base}/api/stats?days=7`, { headers: { authorization: `Bearer ${process.env.DCH_STATS_TOKEN}` } });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.lifetime.pageViews, 1);
    assert.equal(j.lifetime.visitors, 1);
    assert.equal(j.days[0].pageViews, 1);
    assert.doesNotMatch(JSON.stringify(j), /127\.0\.0\.1/);
    assert.equal((await fetch(`${base}/api/stats`, { method: "POST", headers: { authorization: `Bearer ${process.env.DCH_STATS_TOKEN}` } })).status, 404);
  } finally {
    srv.close();
    delete process.env.DCH_STATS_TOKEN;
  }
  assert.equal(statsAuthorized("Bearer short", "short"), false, "tokens under 16 chars are refused");
  assert.equal(statsAuthorized("Bearer abcdefghijklmnopq", ""), false, "unset token: always 404");
});

test("CLI: npm run dch -- stats reads the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dch-stats-cli-"));
  const env = { ...process.env, DCH_DATA_DIR: dir };
  const run = (...a: string[]) => execFileSync(process.execPath, ["src/cli.ts", "stats", ...a], { env, encoding: "utf8" });
  assert.match(run(), /no stats yet/);
  const s = new Stats(join(dir, "stats.json"), { network: "devnet", flushMs: 0 });
  s.visit("198.51.100.1", "Safari");
  s.record({}, { type: "world" });
  s.record({}, { type: "quizFirst", id: "issue", points: 20 });
  const out = run();
  assert.match(out, /Lifetime: visitors 1 .*worlds started 1.*avg first-try quiz points 20\/30/);
  assert.equal(JSON.parse(run("--json")).lifetime.worldsStarted, 1);
  assert.match(formatStats(s.snapshot(), ["wallet", "issue"]), /quizzes passed: {3}wallet 0, issue 0/);
});

test("save failures never throw: one short log line, counts kept in memory, retried", () => {
  const blocker = join(DIR, "not-a-dir");
  (require_fs()).writeFileSync(blocker, "x"); // a file where the data dir should be: mkdir fails, even as root
  const lines: string[] = [];
  const s = new Stats(join(blocker, "stats.json"), { network: "devnet", flushMs: 0, log: (m) => lines.push(m) });
  s.visit("198.51.100.1", "Safari");
  s.record({}, { type: "world" });
  assert.equal(s.flush(), false);
  assert.equal(s.data.lifetime.worldsStarted, 1);
  assert.equal(lines.length, 1, "logged once, not on every change");
  assert.doesNotMatch(lines[0], /not-a-dir|stats\.json|198\.51|\//, "no paths or values in the log");
  require_fs().rmSync(blocker); // disk fixed: the next save writes everything kept in memory
  s.record({}, { type: "grad" });
  assert.equal(Stats.read(join(blocker, "stats.json"))?.lifetime.worldsStarted, 1);
});

test("a corrupt stats.json is moved aside, not overwritten; temp file name is fixed", () => {
  const dir = mkdtempSync(join(tmpdir(), "dch-stats-corrupt-"));
  const path = join(dir, "stats.json");
  require_fs().writeFileSync(path, "{not json");
  const lines: string[] = [];
  const s = new Stats(path, { network: "devnet", flushMs: 0, log: (m) => lines.push(m), now: () => Date.parse("2026-11-22T20:00:00Z") });
  const aside = readdirSync(dir).filter((f) => f.startsWith("stats.json.corrupt-2026-11-22"));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(dir, aside[0]), "utf8"), "{not json");
  assert.equal(lines.length, 1);
  s.record({}, { type: "world" });
  assert.deepEqual(readdirSync(dir).sort(), ["stats.json", aside[0]].sort(), "no leftover temp; only stats.json(.tmp) names are used");
  assert.match(readFileSync(new URL("../src/stats.ts", import.meta.url), "utf8"), /`\$\{this\.path\}\.tmp`/);
});

test("an unwritable data dir doesn't kill the server: it starts, serves, and stays up", async () => {
  const blocker = join(DIR, "data-is-a-file");
  require_fs().writeFileSync(blocker, "x");
  const { spawn } = await import("node:child_process");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, DCH_DATA_DIR: blocker, PORT: String(port), HOST: "127.0.0.1", XRPL_NETWORK: "devnet", DCH_STATS_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    const t0 = Date.now();
    while (!/DCH tutorial game on/.test(out)) {
      if (child.exitCode !== null) assert.fail(`server exited: ${out}`);
      if (Date.now() - t0 > 15_000) assert.fail(`server didn't start: ${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200); // page views try to save
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(child.exitCode, null, "still running");
    assert.match(out, /stats: couldn't save the counts/, "the startup backfill save failed and was only logged");
    assert.doesNotMatch(out, /data-is-a-file/, "no paths logged");
  } finally {
    child.kill("SIGKILL");
  }
});
