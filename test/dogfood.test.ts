// Slice 12 (dogfood fixes): level gating (no skipping past unfinished steps or quizzes), the
// quiz pointer, the header seat, and background level runs with polling (phones drop long fetches).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet } from "xrpl";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-dogfood-"));
const { Game } = await import("../src/game.ts");
const { createHandler } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");
const { RateLimiter, DEFAULT_RULES } = await import("../src/limits.ts");
const { JobStore, JOB_ID_RE } = await import("../src/jobs.ts");
const M: any = await import("../public/mapstate.js" as string);

const quiz = (passed = false) => ({ passed, answers: [] });
const lv = (id: string, n: number, extra: any = {}) => ({ id, n, title: id, goalRoles: n === 0 || n === 8 ? [] : ["issuer"], score: { goal: false, shouldFail: false }, quiz: quiz(), ...extra });
const done = { goal: true, shouldFail: true };

test("levelTodo: steps before quiz; the quiz only counts once steps are done", () => {
  assert.equal(M.levelTodo(lv("wallet", 0), { walletDone: false }), "wallet");
  assert.equal(M.levelTodo(lv("wallet", 0), { walletDone: true }), "quiz");
  assert.equal(M.levelTodo(lv("wallet", 0, { quiz: quiz(true) }), { walletDone: true }), null);
  assert.equal(M.levelTodo(lv("issue", 1)), "goal");
  assert.equal(M.levelTodo(lv("issue", 1, { score: { goal: true, shouldFail: false } })), "shouldFail");
  assert.equal(M.levelTodo(lv("issue", 1, { score: done })), "quiz");
  assert.equal(M.levelTodo(lv("issue", 1, { score: done, quiz: quiz(true) })), null);
  assert.equal(M.levelTodo(lv("confidential", 8)), "quiz"); // explainer: its quiz alone
});

test("canOpen: the next level stays locked until the current level's steps AND quiz pass (bug f)", () => {
  const ctx = { walletDone: true };
  // Level 1 not run: Level 2 must not open, whatever button or URL leads there.
  let levels = [lv("wallet", 0, { quiz: quiz(true) }), lv("issue", 1), lv("freeze", 2)];
  assert.deepEqual(M.canOpen(levels, "freeze", ctx), { ok: false, current: "issue" });
  assert.equal(M.canOpen(levels, "issue", ctx).ok, true);
  assert.equal(M.canOpen(levels, "wallet", ctx).ok, true); // done levels replay
  // Steps done, quiz not passed: still locked.
  levels = [lv("wallet", 0, { quiz: quiz(true) }), lv("issue", 1, { score: done }), lv("freeze", 2)];
  assert.equal(M.canOpen(levels, "freeze", ctx).ok, false);
  levels[1].quiz = quiz(true);
  assert.equal(M.canOpen(levels, "freeze", ctx).ok, true);
  // No seat with your wallet (Level 0 unfinished): Level 1 locked.
  assert.deepEqual(M.canOpen([lv("wallet", 0), lv("issue", 1)], "issue", { walletDone: false }), { ok: false, current: "wallet" });
  // Coming-soon levels open (they only show the notice) and never block.
  levels.push(lv("lend", 7, { available: false }));
  assert.equal(M.canOpen(levels, "lend", ctx).ok, true);
  assert.equal(M.canOpen(levels, "nope", ctx).ok, false);
});

test("clampStep: a saved step can't land past the first card you can't pass", () => {
  assert.equal(M.clampStep(6, [false, false, true, true, false, false, false]), 2);
  assert.equal(M.clampStep(1, [false, false, true]), 1);
  assert.equal(M.clampStep(9, [false, false]), 1);
  assert.equal(M.clampStep(-3, [false]), 0);
  assert.equal(M.clampStep(undefined, [false, true]), 0);
});

test("quizPending: worlds that finished steps before quizzes see which switches need a quiz (bug e)", () => {
  const levels = [lv("wallet", 0, { quiz: quiz(true) }), lv("issue", 1, { score: done }), lv("freeze", 2, { score: done }), lv("creds", 3), lv("confidential", 8)];
  assert.deepEqual(M.quizPending(levels, { walletDone: true }).map((l: any) => l.id), ["issue", "freeze"]);
});

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
test("client: no finish card offers the next level while the level is unfinished (bug b)", () => {
  assert.match(app, /todoCard\(l, "Almost there"/);
  assert.match(app, /todoCard\(l, "Quiz locked"/);
  assert.match(app, /todoCard\(l, "Finish the quiz"/);
  assert.match(app, /todoCard\(l, "Wallet step"/);
  assert.doesNotMatch(app, /finishCard\(l, "Almost there"/);
  // run steps can't be skipped with Next
  assert.match(app, /nextDisabled: !l\.score\.goal/);
  assert.match(app, /nextDisabled: !l\.score\.shouldFail/);
  assert.match(app, /if \(!gate\.ok\) return lockedScreen/);
});
test("client: the quiz choices carry the pointer until one is picked", () => {
  assert.match(app, /"data-pt": `quiz-choices-\$\{i\}`/);
  assert.match(app, /target: \(\) => \(!a && !qz\.passed && !over && !blocked && !busy \? group : null\)/);
});
test("client: header seat is the seat linked to your wallet (bug a)", () => {
  assert.match(app, /x\.wallet === addr\(\)\) \|\|/);
});
test("client: level runs go through async jobs and keep polling after a dropped connection (bug d)", () => {
  assert.match(app, /async: true/);
  assert.match(app, /\/api\/jobs\//);
  assert.match(app, /instanceof NetError/);
});

test("JobStore: random ids, joins a running slot, keeps results, expires finished jobs", async () => {
  let now = 1000;
  const js = new JobStore(60_000, 3, () => now);
  let release!: (v: unknown) => void;
  const a = js.start("w|lend|goal", () => new Promise((r) => (release = r)));
  assert.match(a.id, JOB_ID_RE);
  assert.equal(js.start("w|lend|goal", async () => "other").id, a.id, "double press joins the running job");
  assert.equal(JobStore.view(a).status, "running");
  assert.equal("slot" in JobStore.view(a), false, "the world address never leaves the server");
  release({ ok: true, added: 10 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(JobStore.view(js.get(a.id)!).result, { ok: true, message: undefined, added: 10, results: [] });
  const b = js.start("w|lend|goal", async () => { throw new Error("boom"); });
  assert.notEqual(b.id, a.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(js.get(b.id)!.status, "error");
  assert.equal(JobStore.view(js.get(b.id)!).error, "boom");
  assert.equal(js.get("../../etc"), null);
  now += 61_000;
  assert.equal(js.get(a.id), null, "finished jobs expire");
  // cap: when every job is running, refuse
  const never = () => new Promise(() => {});
  js.start("x1", never); js.start("x2", never); js.start("x3", never);
  assert.throws(() => js.start("x4", never), /Too many level runs/);
});

test("server: {async:true} level run answers 202 with a job, GET /api/jobs/<id> polls it to the result", async () => {
  const g = new Game(loadConfig({}), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 100, maxAwards: 100 });
  const any = g as any;
  any.ledger = async () => ({});
  any.fundAccounts = async () => Object.fromEntries(["issuer", "holder", "lender", "borrower", "auditor", "holderBot"].map((k) => { const w = Wallet.generate(); return [k, { address: w.address, seed: w.seed }]; }));
  any.shared.amendments = { network: "devnet", checkedAt: new Date(0).toISOString(), amendments: {} };
  any.levelAvailable = () => true;
  let finish!: () => void;
  any.play = (level: string, part: string) => new Promise((r) => (finish = () => r({ ok: true, level, part, added: 10, message: "done" })));
  const a = Wallet.generate().address;
  await g.startWorld(a);
  const server = createServer(createHandler(g, new RateLimiter(DEFAULT_RULES), false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    let r = await post("/api/levels/lend/should-fail", { world: a, async: true });
    assert.equal(r.status, 202);
    const j = await r.json();
    assert.equal(j.status, "running");
    assert.match(j.job, JOB_ID_RE);
    assert.equal(JSON.stringify(j).includes(a), false);
    r = await fetch(`${base}/api/jobs/${j.job}`);
    assert.equal((await r.json()).status, "running");
    finish();
    await new Promise((res) => setTimeout(res, 20));
    const d = await (await fetch(`${base}/api/jobs/${j.job}`)).json();
    assert.equal(d.status, "done");
    assert.deepEqual(d.result, { ok: true, message: "done", added: 10, results: [] }, "finished jobs keep only message, points, score and tx refs");
    assert.equal((await fetch(`${base}/api/jobs/AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
    assert.equal((await post("/api/levels/nope/goal", { world: a, async: true })).status, 400);
    // without a world (shared world off over HTTP) async runs are refused like sync ones
    process.env.DCH_SHARED_WORLD_HTTP = "0";
    assert.equal((await post("/api/levels/issue/goal", { async: true })).status, 403);
    delete process.env.DCH_SHARED_WORLD_HTTP;
    // the synchronous route still works (CLI and older pages)
    const s = post("/api/levels/issue/goal", { world: a });
    await new Promise((res) => setTimeout(res, 20));
    finish();
    assert.equal((await s).status, 200);
  } finally { server.close(); }
});

test("Level 2 goal resumes after a run that stopped halfway (no tecOWNERS lock-out)", async () => {
  const { level2Runners } = await import("../src/levels/level2.ts");
  const claw = Wallet.generate().address, bot = Wallet.generate().address;
  // World after a run that enabled clawback, opened the line and got 50 CLW, then timed out.
  let frozen = false, balance = 50;
  const sent: any[] = [];
  const ctx: any = {
    ensureAccount: async () => claw, address: () => bot, note: () => {},
    client: { request: async (r: any) => r.command === "account_info"
      ? { result: { account_data: { Flags: 0x80000000 } } }
      : { result: { lines: [{ currency: "CLW", balance: String(balance), freeze_peer: frozen }] } } },
    submit: async (_k: string, tx: any) => {
      sent.push(tx.TransactionType + (tx.SetFlag ? ":set" : ""));
      if (tx.TransactionType === "TrustSet" && tx.Flags) frozen = true;
      if (tx.TransactionType === "Clawback") balance -= Number(tx.Amount.value);
      return { engineResult: "tesSUCCESS", validated: true, hash: "H", type: tx.TransactionType };
    },
  };
  const out = await level2Runners.runGoal(ctx);
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(sent, ["TrustSet", "Clawback"], "skips the clawback flag, trust line and payment that already happened");
});
