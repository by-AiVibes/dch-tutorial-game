// One world per player: isolation, caps, LRU eviction, address validation. No network access:
// faucet funding and the ledger connection are replaced with fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet } from "xrpl";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-worlds-"));
const { Game } = await import("../src/game.ts");
const { createHandler } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");
const { CapError, RateLimiter, DEFAULT_RULES } = await import("../src/limits.ts");
const { statePath } = await import("../src/store.ts");
const M: any = await import("../public/mapstate.js" as string);

const A = Wallet.generate().address, B = Wallet.generate().address, C = Wallet.generate().address;
const SEED = Wallet.generate().seed as string;
const AMEND = { network: "devnet", checkedAt: new Date(0).toISOString(), amendments: {} };

/** A Game whose faucet and ledger are fakes; counts faucet "requests". */
function fakeGame(caps: Partial<{ maxWorlds: number; minIdleMs: number; newPerHour: number }> = {}, clock = { t: 1_000_000 }) {
  const g = new Game(loadConfig({}), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 30, ...caps }, () => clock.t);
  const any = g as any;
  any.funded = 0;
  any.ledger = async () => ({});
  any.fundAccounts = async () => {
    const out: Record<string, { address: string; seed: string }> = {};
    for (const k of ["issuer", "holder", "lender", "borrower", "auditor", "holderBot"]) {
      const w = Wallet.generate();
      out[k] = { address: w.address, seed: w.seed as string };
      any.funded++;
    }
    return out;
  };
  any.shared.amendments = AMEND;
  return { g, any, clock };
}
const done = (v: any) => M.mapState(v.levels, { walletDone: false, read: [] });

test("isolation: player B sees a fresh circuit after player A completes levels", async () => {
  const { g, any } = fakeGame();
  await g.startWorld(A);
  await g.startWorld(B);
  // A clears every scored level (written the way play() records it).
  const wa = any.st(A);
  for (const l of g.view(A).levels) if (l.goalRoles.length) wa.scores[l.id] = { goal: true, shouldFail: true };
  any.persist(wa);
  const { QUIZZES } = await import("../src/quizzes.ts");
  for (const [i, q] of QUIZZES.issue.entries()) await g.answerQuiz("issue", i, q.answer, A); // a switch closes once its quiz passes
  const va = g.view(A), vb = g.view(B);
  assert.equal(va.levelScore, 140);
  assert.equal(vb.score, 0);
  assert.ok(vb.levels.every((l: any) => !l.score.goal && !l.score.shouldFail));
  assert.equal(done(vb).doneCount, 0, "B's circuit is fresh");
  assert.equal(va.levels.filter((l: any) => l.score.goal && l.score.shouldFail).length, 7, "A cleared all seven scored levels");
  assert.ok(done(va).nodes.find((n: any) => n.id === "issue").closed, "A's Level 1 switch is closed");
  assert.equal(done(vb).nodes.find((n: any) => n.id === "issue").closed, false, "B's Level 1 switch is open");
  assert.notEqual(va.accounts.issuer.address, vb.accounts.issuer.address, "separate funded accounts");
  assert.equal(g.view(null).score, 0, "shared world untouched");
  // A's world survives a restart; B is still fresh.
  const { g: g2 } = fakeGame();
  assert.equal(g2.view(A).levelScore, 140);
  assert.equal(g2.view(B).score, 0);
});

test("seats are per world: many players can each hold the same seat", async () => {
  const { g } = fakeGame();
  const players = Array.from({ length: 8 }, () => Wallet.generate().address);
  for (const [i, p] of players.entries()) {
    await g.startWorld(p);
    const v = g.claim("issuer", `tester${i}`, p, p);
    assert.equal(v.seats.issuer.player, `tester${i}`);
    assert.equal(v.seats.issuer.wallet, p);
  }
  assert.throws(() => g.claim("issuer", "x", null, Wallet.generate().address), /Start your world first/);
});

test("start is idempotent: an existing world is returned without spending faucet requests", async () => {
  const { g, any } = fakeGame();
  await g.startWorld(A);
  const n = any.funded;
  await g.startWorld(A);
  assert.equal(any.funded, n);
  await g.startWorld(A, true);
  assert.equal(any.funded, n + 6, "fresh = true funds a new set");
  assert.equal(g.view(A).world, 2);
});

test("cap: new worlds per hour -> 429 with the real wait; frees up after the hour", async () => {
  const clock = { t: 5_000_000 };
  const { g } = fakeGame({ newPerHour: 2 }, clock);
  await g.startWorld(Wallet.generate().address);
  clock.t += 600_000;
  await g.startWorld(Wallet.generate().address);
  await assert.rejects(g.startWorld(Wallet.generate().address), (e: any) => e instanceof CapError && e.status === 429 && e.retryAfter === 3000);
  clock.t += 3_000_000;
  await g.startWorld(Wallet.generate().address); // the first creation aged out
});

test("cap: stored worlds evict the least-recently-used idle world, else 503 with Retry-After", async () => {
  const clock = { t: 9_000_000 };
  const { g } = fakeGame({ maxWorlds: 2, minIdleMs: 60_000 }, clock);
  // other tests' worlds share this data dir: size the cap so only X, Y, Z compete
  const before = new Set((existsSync(join(process.env.DCH_DATA_DIR!, "players")) ? readdirSync(join(process.env.DCH_DATA_DIR!, "players")) : []));
  const X = Wallet.generate().address, Y = Wallet.generate().address, Z = Wallet.generate().address;
  const g2 = new Game(loadConfig({}), () => {}, { maxWorlds: before.size + 2, minIdleMs: 60_000, newPerHour: 100 }, () => clock.t);
  Object.assign(g2 as any, { ledger: (g as any).ledger, fundAccounts: (g as any).fundAccounts });
  (g2 as any).shared.amendments = AMEND;
  // earlier tests' worlds count as recently used, so X is the only idle candidate later
  for (const k of (g2 as any).lastUsed.keys()) (g2 as any).lastUsed.set(k, clock.t);
  await g2.startWorld(X);
  clock.t += 10;
  await g2.startWorld(Y);
  clock.t += 10;
  await assert.rejects(g2.startWorld(Z), (e: any) => e instanceof CapError && e.status === 503 && e.retryAfter >= 59);
  clock.t += 120_000;
  g2.claim("holder", "y", null, Y); // Y used recently (a mutating call); X and the older worlds are idle
  for (const k of (g2 as any).lastUsed.keys()) if (k !== X && k !== Y) (g2 as any).lastUsed.set(k, clock.t); // keep others active
  await g2.startWorld(Z);
  assert.equal(existsSync(statePath("devnet", X)), false, "LRU idle world X evicted");
  assert.equal(existsSync(statePath("devnet", Y)), true);
  assert.equal(existsSync(statePath("devnet", Z)), true);
  assert.equal(g2.view(X).world, 0, "X would start fresh");
});

test("address validation: only classic addresses become world keys", async () => {
  const { g } = fakeGame();
  for (const bad of ["", "abc", "../../etc/passwd", "rNOTREAL", SEED, "X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ", A + "/x", A.slice(0, -1) + (A.endsWith("a") ? "b" : "a")]) {
    if (bad === "") { await assert.rejects(g.startWorld(bad), /classic XRPL address/); continue; }
    await assert.rejects(g.startWorld(bad), /classic XRPL address|never send a seed/, bad.slice(0, 12));
  }
  assert.throws(() => statePath("devnet", "../x"), /bad world key/);
  assert.throws(() => statePath("../devnet", A), /bad network/);
});

test("server: start route, per-world state, per-IP 429, cap 429/503 with Retry-After, seeds refused", async () => {
  const clock = { t: 20_000_000 };
  const { g } = fakeGame({ newPerHour: 1 }, clock);
  const server = createServer(createHandler(g, new RateLimiter({ ...DEFAULT_RULES, world: { max: 3, windowMs: 3_600_000 } }), false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    const P = Wallet.generate().address, Q = Wallet.generate().address;
    let r = await post("/api/world/start", { world: P });
    assert.equal(r.status, 200);
    const v = await r.json();
    assert.equal(v.owner, P);
    assert.ok(!JSON.stringify(v).includes('"seed"'), "no seeds in the view");
    assert.equal((await (await fetch(`${base}/api/state?world=${P}`)).json()).world, 1);
    assert.equal((await (await fetch(`${base}/api/state?world=${Q}`)).json()).world, 0, "Q has no world yet");
    r = await post("/api/world/start", { world: Q }); // global cap of 1/hour reached
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 3000);
    r = await post("/api/world/start", { world: SEED });
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes(SEED), "seed never echoed");
    r = await fetch(`${base}/api/state?world=${encodeURIComponent(SEED)}`);
    assert.equal(r.status, 400);
    r = await post("/api/world/start", { world: P }); // 4th from this IP within the hour
    assert.equal(r.status, 429, "per-IP world class");
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    // seats in P's world don't touch the shared world
    r = await post("/api/seat/claim", { role: "holder", player: "dane", world: P, wallet: P });
    assert.equal(r.status, 200);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).seats.holder.player, null);
    // shared world can be closed to HTTP play on public hosts
    process.env.DCH_SHARED_WORLD_HTTP = "0";
    r = await post("/api/seat/claim", { role: "holder", player: "dane" });
    assert.equal(r.status, 403);
    delete process.env.DCH_SHARED_WORLD_HTTP;
  } finally {
    await new Promise((r) => server.close(r));
  }
  // nothing on disk holds a seed that came from a request
  for (const f of readdirSync(join(process.env.DCH_DATA_DIR!, "players"))) assert.ok(!readFileSync(join(process.env.DCH_DATA_DIR!, "players", f), "utf8").includes(SEED));
});

test("lastUsed: reads (state, objects) don't refresh a world; start, seats and level runs do", async () => {
  const clock = { t: 30_000_000 };
  const { g, any } = fakeGame({}, clock);
  const P = Wallet.generate().address;
  await g.startWorld(P);
  const t0 = any.lastUsed.get(P);
  clock.t += 1000;
  g.view(P);
  any.st(P);
  await g.objects(P).catch(() => undefined); // fake ledger has no request(); the read must not touch either way
  assert.equal(any.lastUsed.get(P), t0, "GET-style reads leave lastUsed alone");
  g.claim("holder", "p", null, P);
  assert.equal(any.lastUsed.get(P), clock.t, "claim refreshes");
  clock.t += 1000;
  g.release("holder", "p", P);
  assert.equal(any.lastUsed.get(P), clock.t, "release refreshes");
  clock.t += 1000;
  await g.play("nosuchlevel", "goal", "p", P).catch(() => undefined);
  assert.equal(any.lastUsed.get(P), clock.t, "a level run refreshes");
  clock.t += 1000;
  await g.startWorld(P);
  assert.equal(any.lastUsed.get(P), clock.t, "start (even idempotent) refreshes");
});

test("cap: starts still funding count toward the stored-world cap (no overshoot)", async () => {
  const clock = { t: 40_000_000 };
  const { g, any } = fakeGame({}, clock);
  const n = any.lastUsed.size;
  any.caps = { maxWorlds: n + 1, minIdleMs: 3_600_000, newPerHour: 100 };
  for (const k of any.lastUsed.keys()) any.lastUsed.set(k, clock.t); // nothing idle to evict
  const real = any.fundAccounts;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  any.fundAccounts = async (c: unknown) => { await gate; return real(c); };
  const X = Wallet.generate().address, Y = Wallet.generate().address;
  const px = g.startWorld(X); // in flight: holds the last slot
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(g.startWorld(Y), (e: any) => e instanceof CapError && e.status === 503 && e.retryAfter > 0);
  release();
  await px;
  assert.equal(any.lastUsed.size, n + 1, "exactly at the cap");
  assert.equal(any.pending.size, 0);
  // a failed start frees its in-flight slot
  any.caps = { ...any.caps, maxWorlds: n + 2 };
  any.fundAccounts = async () => { throw new Error("faucet failed."); };
  await assert.rejects(g.startWorld(Y), /faucet failed/);
  assert.equal(any.pending.size, 0);
});

test("server: with the shared world off, no ?world gives a blank view, not the shared world", async () => {
  const { g, any } = fakeGame();
  any.shared.world = 3;
  any.shared.scores = { issue: { goal: true, shouldFail: true } };
  const server = createServer(createHandler(g, new RateLimiter(DEFAULT_RULES), false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    let v = await (await fetch(`${base}/api/state`)).json();
    assert.equal(v.world, 3, "shared world visible by default (CLI/instructor setups)");
    process.env.DCH_SHARED_WORLD_HTTP = "0";
    v = await (await fetch(`${base}/api/state`)).json();
    assert.equal(v.world, 0);
    assert.equal(v.score, 0);
    assert.equal(v.owner, null);
    assert.deepEqual(v.accounts ?? {}, {});
    assert.ok(v.levels.every((l: any) => !l.score.goal && !l.score.shouldFail), "no shared scores leak");
    const o = await (await fetch(`${base}/api/objects`)).json();
    assert.deepEqual(o, { network: "devnet", world: 0, objects: [] });
  } finally {
    delete process.env.DCH_SHARED_WORLD_HTTP;
    await new Promise((r) => server.close(r));
  }
});
