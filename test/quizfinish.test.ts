// Finishing a level's last quiz question: the server closes the switch and unlocks the next
// level; the page shows a spinner while the answer is checked (so players and the e2e player
// wait instead of seeing a frozen card); jobs keep slim results and report busy errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-quizfinish-"));
const { Game } = await import("../src/game.ts");
const { loadConfig } = await import("../src/config.ts");
const { QUIZZES } = await import("../src/quizzes.ts");
const { JobStore, slimResult } = await import("../src/jobs.ts");
const { BusyError } = await import("../src/limits.ts");
const M: any = await import("../public/mapstate.js" as string);

function fakeGame() {
  const g = new Game(loadConfig({}), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 100, maxAwards: 100 });
  const any = g as any;
  any.ledger = async () => ({});
  any.fundAccounts = async () => Object.fromEntries(["issuer", "holder", "lender", "borrower", "auditor", "holderBot"].map((k) => { const w = Wallet.generate(); return [k, { address: w.address, seed: w.seed }]; }));
  any.shared.amendments = { network: "devnet", checkedAt: new Date(0).toISOString(), amendments: {} };
  any.levelAvailable = () => true;
  return { g, any };
}

test("answering the LAST quiz question closes the switch and unlocks the next level", async () => {
  const { g, any } = fakeGame();
  const a = Wallet.generate().address;
  await g.startWorld(a);
  const st = any.st(Game.key(a));
  st.seats.issuer.wallet = a; st.seats.issuer.player = "you";
  st.scores.issue = { goal: true, shouldFail: true };
  for (const [i, q] of QUIZZES.wallet.entries()) await g.answerQuiz("wallet", i, q.answer, a);
  const qs = QUIZZES.issue;
  await g.answerQuiz("issue", 0, qs[0].answer, a);
  const mid = await g.answerQuiz("issue", 1, qs[1].answer, a);
  assert.equal(mid.done, false);
  assert.equal(mid.view.score, 50, "points land when the attempt ends, so the score waits for Q3");
  const last = await g.answerQuiz("issue", 2, qs[2].answer, a);
  assert.equal(last.done, true);
  assert.equal(last.passed, true);
  assert.equal(last.view.score, 80);
  const v = g.view(Game.key(a));
  const issue: any = v.levels.find((l: any) => l.id === "issue");
  assert.equal(issue.quiz.passed, true);
  assert.equal(issue.quiz.answers.length, 3);
  const ctx = { walletDone: true };
  assert.equal(M.levelDone(issue, ctx), true);
  assert.equal(M.levelTodo(issue, ctx), null);
  assert.equal(M.canOpen(v.levels, "freeze", ctx).ok, true, "Level 2 opens once Q3 is in");
  // A second click on Q3 (double tap during a slow response) is refused, not double-counted.
  await assert.rejects(g.answerQuiz("issue", 2, qs[2].answer, a), /already passed/);
  assert.equal(g.view(Game.key(a)).score, 80);
});

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
test("page: while an answer is checked it shows a spinner and exposes busy to the DOM", () => {
  assert.match(app, /document\.body\.dataset\.busy = busy \|\| ""/);
  assert.match(app, /busy === "quiz" && !a \? el\("p", \{ class: "result", role: "status" \}, el\("span", \{ class: "spinner"/);
  assert.match(app, /busy === "quiz" \? "Checking your answer…"/);
  assert.doesNotMatch(app, /AbortSignal\.timeout/, "missing on Safari/iOS < 16");
  assert.match(app, /new AbortController\(\)/);
  assert.match(app, /finally \{ clearTimeout\(timer\); \}/);
});
test("e2e player waits on busy and gives slow screens 10 s before a dead end", () => {
  const e2e = readFileSync(new URL("../e2e/play.mjs", import.meta.url), "utf8");
  assert.match(e2e, /document\.body\.dataset\.busy/);
  assert.match(e2e, /nothing to press after 10 s/);
  assert.match(e2e, /--latency/);
  const pt = readFileSync(new URL("../scripts/play-through.mjs", import.meta.url), "utf8");
  assert.match(pt, /devnet\/testnet only/);
});
test("map says Continue, not Start, when quizzes are waiting", () => {
  assert.match(app, /const fresh = ms\.doneCount === 0 && !ui\.step\.wallet && !state\.score && !quizPending\(/);
});

test("jobs: finished results are slim; busy errors say so in the poll response", async () => {
  const big = { ok: true, message: "m", added: 10, view: { score: 90, maxScore: 410, levels: new Array(9).fill({ x: "y".repeat(1000) }) },
    results: Array.from({ length: 7 }, (_, i) => ({ type: "Payment", engineResult: "tesSUCCESS", hash: "H" + i, meta: { big: "z".repeat(5000) } })) };
  const s: any = slimResult(big);
  assert.deepEqual(Object.keys(s).sort(), ["added", "maxScore", "message", "ok", "results", "score"]);
  assert.equal(s.score, 90);
  assert.equal(s.results.length, 4);
  assert.deepEqual(s.results[3], { type: "Payment", engineResult: "tesSUCCESS", hash: "H6" });
  assert.ok(JSON.stringify(s).length < 400);
  const js = new JobStore();
  const j = js.start("w|x|goal", async () => { throw new BusyError(); }, (e) => (e instanceof BusyError ? 503 : 400));
  await new Promise((r) => setImmediate(r));
  const v: any = JobStore.view(js.get(j.id)!);
  assert.equal(v.status, "error");
  assert.equal(v.errorStatus, 503);
  assert.equal(v.busy, true);
  const k = js.start("w|y|goal", async () => { throw new Error("bad level"); });
  await new Promise((r) => setImmediate(r));
  const kv: any = JobStore.view(js.get(k.id)!);
  assert.equal(kv.busy, false);
  assert.equal(kv.errorStatus, 400);
  assert.match(app, /job\.busy \? "The server is busy\. Try again in a few seconds\."/);
});

/** The page's api() helper, run in a sandbox with a fake fetch and a short timeout. */
function pageApi(fetchImpl: unknown, { abortController = true } = {}) {
  const src = app.slice(app.indexOf("const API_TIMEOUT_MS"), app.indexOf("const sleep ="));
  const body = src.replace("const API_TIMEOUT_MS = 90_000;", "const API_TIMEOUT_MS = 60;") + "\nreturn { api, NetError, SlowError };";
  return new Function("fetch", "AbortController", "setTimeout", "clearTimeout", body)(fetchImpl, abortController ? AbortController : undefined, setTimeout, clearTimeout);
}
const okResponse = (j: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => j });

test("page api(): a request that never answers says the ledger is slow (with or without AbortController)", async () => {
  let aborted = false;
  const hang = (_p: string, o: any) => new Promise((_, rej) => o?.signal?.addEventListener("abort", () => { aborted = true; rej(new Error("AbortError")); }));
  const { api, SlowError } = pageApi(hang);
  await assert.rejects(api("/api/state"), (e: any) => e instanceof SlowError && e.message === "The ledger is slow. Reload to see where you are.");
  assert.equal(aborted, true, "the hung fetch is aborted");
  // Safari/iOS < 16 style: no AbortSignal.timeout, maybe no AbortController either: still times out.
  const old = pageApi(() => new Promise(() => {}), { abortController: false });
  await assert.rejects(old.api("/api/state"), /The ledger is slow/);
});
test("page api(): a real network failure still says the connection dropped; good answers clear the timer", async () => {
  const { api, NetError, SlowError } = pageApi(async () => { throw new TypeError("Load failed"); });
  await assert.rejects(api("/api/quiz/answer", {}), (e: any) => e instanceof NetError && !(e instanceof SlowError) && e.message === "The connection dropped.");
  const good = pageApi(async () => okResponse({ ok: 1 }));
  assert.deepEqual(await good.api("/api/state"), { ok: 1 });
  await new Promise((r) => setTimeout(r, 100)); // the 60 ms timer was cleared: no stray rejection
});
