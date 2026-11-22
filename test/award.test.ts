// Graduation award: server-verified completion, unguessable stable ids, PNG rendering, share
// page tags, name escaping. No network access: faucet and ledger are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet } from "xrpl";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-award-"));
const { Game } = await import("../src/game.ts");
const { createHandler } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");
const { RateLimiter, DEFAULT_RULES } = await import("../src/limits.ts");
const { SCORED_LEVELS } = await import("../src/levels/index.ts");
const { statePath } = await import("../src/store.ts");
const AW = await import("../src/award.ts");

function fakeGame() {
  const g = new Game(loadConfig({}), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 100, maxAwards: 100 });
  const any = g as any;
  any.ledger = async () => ({});
  any.fundAccounts = async () => Object.fromEntries(["issuer", "holder", "lender", "borrower", "auditor", "holderBot"].map((k) => { const w = Wallet.generate(); return [k, { address: w.address, seed: w.seed }]; }));
  any.shared.amendments = { network: "devnet", checkedAt: new Date(0).toISOString(), amendments: {} };
  any.levelAvailable = () => true; // every level is live on this pretend network
  return { g, any };
}

/** A player world with Level 0 done and, optionally, every scored level done. */
async function player(g: any, any: any, opts: { seat?: boolean; skip?: string } = {}) {
  const a = Wallet.generate().address;
  await g.startWorld(a);
  if (opts.seat !== false) g.claim("issuer", "you", a, a);
  const w = any.st(a);
  for (const l of SCORED_LEVELS) if (l.id !== opts.skip) w.scores[l.id] = { goal: true, shouldFail: true };
  any.persist(w);
  return a;
}

const pngSize = (b: Buffer) => ({ sig: b.subarray(0, 8).toString("hex"), w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

test("award refused unless the player's own world has every level complete", async () => {
  const { g, any } = fakeGame();
  const noSeat = await player(g, any, { seat: false });
  await assert.rejects(g.graduate(noSeat, "Ann"), /Not graduated yet: finish Level 0/);
  const missing = await player(g, any, { skip: "vault" });
  await assert.rejects(g.graduate(missing, "Ann"), /Not graduated yet: finish Level 6/);
  const fresh = Wallet.generate().address;
  await assert.rejects(g.graduate(fresh, "Ann"), /Not graduated yet/);
  await assert.rejects(g.graduate(null, "Ann"), /classic XRPL address/);
  // half-done goal only
  const half = await player(g, any);
  const w = any.st(half); w.scores.lend = { goal: true, shouldFail: false }; any.persist(w);
  await assert.rejects(g.graduate(half, "Ann"), /Level 7/);
});

test("award id: random, unguessable, stable for a world, never the address", async () => {
  const { g, any } = fakeGame();
  const a = await player(g, any), b = await player(g, any);
  const r1 = await g.graduate(a, "Ann");
  assert.match(r1.id, AW.AWARD_ID_RE);
  assert.equal(r1.score, 140);
  const r2 = await g.graduate(a, "Ann B");
  assert.equal(r2.id, r1.id, "same world, same id (rename keeps the link)");
  assert.equal(AW.loadAward(r1.id)!.name, "Ann B");
  const rb = await g.graduate(b, "Bo");
  assert.notEqual(rb.id, r1.id);
  for (const r of [r1, rb]) { assert.ok(!r.id.includes(a.slice(1, 10)) && !r.id.includes(b.slice(1, 10))); assert.ok(!JSON.stringify(AW.loadAward(r.id)).includes(a)); }
  assert.equal(JSON.parse(readFileSync(statePath("devnet", a), "utf8")).award.id, r1.id, "stored in the world file");
  const ids = new Set(Array.from({ length: 2000 }, AW.newAwardId));
  assert.equal(ids.size, 2000);
  // survives a restart
  const { g: g2, any: any2 } = fakeGame();
  void any2;
  assert.equal((await g2.graduate(a, "Ann B")).id, r1.id);
});

test("PNG renders server-side at 1200x675 with the bundled font, under the size cap, cached on disk", async () => {
  const { g, any } = fakeGame();
  const a = await player(g, any);
  const { id } = await g.graduate(a, "Ünïcødé Ann ⚡");
  const png = AW.awardPng(AW.loadAward(id)!);
  const s = pngSize(png);
  assert.equal(s.sig, "89504e470d0a1a0a");
  assert.equal(s.w, 1200);
  assert.equal(s.h, 675);
  assert.ok(png.length < AW.MAX_PNG_BYTES);
  assert.ok(existsSync(join(AW.awardsDir(), `${id}.png`)), "cached");
  assert.deepEqual(AW.awardPng(AW.loadAward(id)!), png, "served from cache");
  await g.graduate(a, "New name");
  assert.ok(!existsSync(join(AW.awardsDir(), `${id}.png`)), "rename drops the cached image");
  const svg = AW.awardSvg(AW.loadAward(id)!);
  for (const t of ["DCH GRADUATE", "CIRCUIT COMPLETE", "DCH CORE", "POWERED", "SCORE 140/140", "#XRPEducationMonth", "game.dch.everhostx.com", "UTC", "Confidential", "Wallet"]) assert.ok(svg.includes(t), t);
  assert.ok(!/xaman|xumm|price|token sale|invest/i.test(svg));
});

test("names: escaped in SVG and HTML, length-capped, no addresses, no control characters", () => {
  const evil = `<script>alert("x")</script>`.slice(0, 32);
  const rec = { id: "A".repeat(24), network: "devnet", name: AW.cleanName(evil), score: 140, maxScore: 140, date: "2026-11-22", levels: [{ n: 0, short: "Wallet" }] };
  const svg = AW.awardSvg(rec), html = AW.awardHtml(rec);
  assert.ok(!svg.includes("<script") && svg.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script") && html.includes("&lt;script&gt;"));
  assert.ok(!html.includes(`"x"`));
  assert.equal(AW.cleanName("  Ann \u0007\u202e Lee  "), "Ann Lee");
  assert.throws(() => AW.cleanName("x".repeat(33)), /32 characters/);
  assert.throws(() => AW.cleanName("   "), /display name/);
  assert.throws(() => AW.cleanName(42), /display name/);
  assert.throws(() => AW.cleanName(`x ${Wallet.generate().address.slice(0, 26)}`), /not an address/);
  assert.equal(AW.esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("share page has og/twitter tags with absolute same-site URLs", () => {
  const rec = { id: "B".repeat(24), network: "devnet", name: "Ann", score: 140, maxScore: 140, date: "2026-11-22", levels: [{ n: 0, short: "Wallet" }] };
  const html = AW.awardHtml(rec, "https://game.dch.everhostx.com");
  const meta = (k: string) => new RegExp(`<meta (property|name)="${k}" content="([^"]+)">`).exec(html)?.[2];
  assert.equal(meta("twitter:card"), "summary_large_image");
  assert.equal(meta("og:image"), `https://game.dch.everhostx.com/award/${rec.id}.png`);
  assert.equal(meta("twitter:image"), meta("og:image"));
  assert.equal(meta("og:image:width"), "1200");
  assert.equal(meta("og:image:height"), "675");
  assert.match(meta("og:title")!, /Ann: DCH Graduate/);
  assert.match(meta("og:description")!, /#XRPEducationMonth/);
  assert.ok(!/<script|style=|\son\w+=/i.test(html), "nothing that needs a CSP exception");
  process.env.DCH_PUBLIC_URL = "javascript:alert(1)";
  assert.equal(AW.PUBLIC_URL(), "https://game.dch.everhostx.com", "bad base URL falls back");
  delete process.env.DCH_PUBLIC_URL;
});

test("server: POST /api/award verifies, GET /award/<id> (+ .png) serve, unknown ids 404, seeds refused", async () => {
  const { g, any } = fakeGame();
  const server = createServer(createHandler(g, new RateLimiter(DEFAULT_RULES), false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (b: unknown) => fetch(base + "/api/award", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    const half = await player(g, any, { skip: "issue" });
    let r = await post({ world: half, name: "Ann" });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Not graduated yet/);
    const a = await player(g, any);
    r = await post({ world: a, name: "Ann" });
    assert.equal(r.status, 200);
    const card = await r.json();
    assert.equal(card.page, `/award/${card.id}`);
    r = await fetch(base + card.page);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /text\/html/);
    assert.match(await r.text(), /twitter:card" content="summary_large_image"/);
    r = await fetch(base + card.image);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(pngSize(Buffer.from(await r.arrayBuffer())).w, 1200);
    for (const p of [`/award/${"C".repeat(24)}`, `/award/${"C".repeat(24)}.png`, "/award/short", `/award/${a}`, "/award/../world-devnet.json"]) assert.equal((await fetch(base + p)).status, 404, p);
    const seed = Wallet.generate().seed!;
    r = await post({ world: a, name: seed });
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes(seed));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("rate limits: award creation and award views have their own classes", async () => {
  const { classify } = await import("../src/limits.ts");
  assert.equal(classify("POST", "/api/award"), "award");
  assert.equal(classify("GET", `/award/${"D".repeat(24)}.png`), "awardview");
  const rl = new RateLimiter({ ...DEFAULT_RULES, awardview: { max: 2, windowMs: 60_000 } });
  assert.equal(rl.check("1.2.3.4", "awardview"), 0);
  assert.equal(rl.check("1.2.3.4", "awardview"), 0);
  assert.ok(rl.check("1.2.3.4", "awardview") > 0);
});
