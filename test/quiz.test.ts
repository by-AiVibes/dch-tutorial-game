// Quiz gate: server-checked answers, 2 of 3 to pass, retry, score math, award requirements,
// Level 8 counting, answers never shipped to the browser, old worlds take the quizzes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet } from "xrpl";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-quiz-"));
process.env.DCH_PUBLIC_URL = "https://game.example.org";
const { Game } = await import("../src/game.ts");
const { createHandler } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");
const { RateLimiter, DEFAULT_RULES, classify } = await import("../src/limits.ts");
const { SCORED_LEVELS } = await import("../src/levels/index.ts");
const { statePath } = await import("../src/store.ts");
const { QUIZZES, QUIZ_MAX, QUIZ_POINTS } = await import("../src/quizzes.ts");
const AW = await import("../src/award.ts");
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
const right = (id: string, i: number) => QUIZZES[id][i].answer;
const wrong = (id: string, i: number) => (QUIZZES[id][i].answer + 1) % QUIZZES[id][i].choices.length;
async function quiz(g: any, a: string, id: string, pattern: boolean[]) {
  let r: any;
  for (const [i, ok] of pattern.entries()) r = await g.answerQuiz(id, i, ok ? right(id, i) : wrong(id, i), a);
  return r;
}
async function player(g: any, any: any, { scores = true } = {}) {
  const a = Wallet.generate().address;
  await g.startWorld(a);
  g.claim("issuer", "you", a, a);
  if (scores) { const w = any.st(a); for (const l of SCORED_LEVELS) w.scores[l.id] = { goal: true, shouldFail: true }; any.persist(w); }
  return a;
}
const lvl = (v: any, id: string) => v.levels.find((l: any) => l.id === id);

test("2 of 3 correct passes; points = correct answers x 10, locked in", async () => {
  const { g, any } = fakeGame();
  const a = await player(g, any);
  const r1 = await g.answerQuiz("issue", 0, right("issue", 0), a);
  assert.equal(r1.correct, true);
  assert.equal(r1.why, undefined);
  const r2 = await g.answerQuiz("issue", 1, wrong("issue", 1), a);
  assert.equal(r2.correct, false);
  assert.equal(r2.why, QUIZZES.issue[1].why, "a wrong answer gets its one-line why");
  const r3 = await g.answerQuiz("issue", 2, right("issue", 2), a);
  assert.deepEqual([r3.done, r3.passed, r3.right], [true, true, 2]);
  const q = lvl(r3.view, "issue").quiz;
  assert.equal(q.passed, true);
  assert.equal(q.points, 2 * QUIZ_POINTS);
  await assert.rejects(g.answerQuiz("issue", 0, right("issue", 0), a), /already passed/);
  await assert.rejects(g.retryQuiz("issue", a), /already passed/);
});

test("1 of 3 fails; the attempt is over until Try again; a retry starts fresh and only the passing attempt scores", async () => {
  const { g, any } = fakeGame();
  const a = await player(g, any);
  const r = await quiz(g, a, "vault", [false, true, false]);
  assert.deepEqual([r.done, r.passed, r.right], [true, false, 1]);
  assert.equal(lvl(r.view, "vault").quiz.points, 0);
  await assert.rejects(g.answerQuiz("vault", 0, right("vault", 0), a), /press Try again/);
  const v = await g.retryQuiz("vault", a);
  assert.deepEqual(lvl(v, "vault").quiz.answers, []);
  assert.equal(lvl(v, "vault").quiz.attempts, 2);
  const r2 = await quiz(g, a, "vault", [true, true, true]);
  assert.equal(r2.passed, true);
  assert.equal(lvl(r2.view, "vault").quiz.points, 30);
});

test("inputs validated: unknown quiz, bad question/choice, out of order, locked until the level is done", async () => {
  const { g, any } = fakeGame();
  const a = await player(g, any, { scores: false });
  await assert.rejects(g.answerQuiz("nope", 0, 0, a), /unknown quiz/);
  await assert.rejects(g.answerQuiz("__proto__", 0, 0, a), /unknown quiz/);
  await assert.rejects(g.answerQuiz("wallet", 3, 0, a), /bad question/);
  await assert.rejects(g.answerQuiz("wallet", "0", 0, a), /bad question/);
  await assert.rejects(g.answerQuiz("wallet", 0, 9, a), /bad choice/);
  await assert.rejects(g.answerQuiz("wallet", 0, 1.5, a), /bad choice/);
  await assert.rejects(g.answerQuiz("wallet", 1, 0, a), /Answer question 1 next/);
  await assert.rejects(g.answerQuiz("issue", 0, 0, a), /Finish this level/, "scored level locked until goal + should-fail");
  await assert.rejects(g.answerQuiz("wallet", 0, 0, Wallet.generate().address), /Start your world first/);
  await g.answerQuiz("wallet", 0, right("wallet", 0), a); // Level 0 opens once the seat is linked
  await g.answerQuiz("confidential", 0, right("confidential", 0), a); // explainers open in any world
});

test("answers and why lines never reach the browser before a wrong answer", async () => {
  const { g, any } = fakeGame();
  const a = await player(g, any);
  const v = JSON.stringify(g.view(a));
  for (const qs of Object.values(QUIZZES)) for (const q of qs) assert.ok(v.includes(JSON.stringify(q.q)), "questions are shown");
  assert.ok(!/"answer"/.test(v) && !/"why"/.test(v), "no answer keys and no why lines in the view before answering");
  // the client bundle carries no quiz data at all: questions come from the server
  for (const f of readdirSync(new URL("../public/", import.meta.url))) {
    if (!/\.(js|html|css)$/.test(f)) continue;
    const src = readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
    for (const qs of Object.values(QUIZZES)) for (const q of qs) {
      assert.ok(!src.includes(q.q), `${f} must not ship quiz questions`);
      assert.ok(!src.includes(JSON.stringify(q.choices)), `${f} must not ship quiz choices`);
    }
  }
});

test("score math: perfect run = 140 level + 270 quiz = 410; each miss in the passing attempt costs 10", async () => {
  const { g, any } = fakeGame();
  assert.equal(QUIZ_MAX, 270);
  const a = await player(g, any);
  for (const id of Object.keys(QUIZZES)) await quiz(g, a, id, [true, true, true]);
  let v = g.view(a);
  assert.deepEqual([v.score, v.maxScore, v.levelScore, v.quizScore], [410, 410, 140, 270]);
  const b = await player(g, any);
  for (const id of Object.keys(QUIZZES)) await quiz(g, b, id, id === "lend" || id === "wallet" ? [true, false, true] : [true, true, true]);
  v = g.view(b);
  assert.equal(v.score, 390);
});

test("award requires every quiz; Level 8 counts through its quiz, so the card shows 9/9", async () => {
  const { g, any } = fakeGame();
  const a = await player(g, any);
  for (const id of Object.keys(QUIZZES)) if (id !== "confidential") await quiz(g, a, id, [true, true, true]);
  await assert.rejects(g.graduate(a, "Ann"), /the Level 8 quiz/);
  await quiz(g, a, "confidential", [false, false, false]);
  await assert.rejects(g.graduate(a, "Ann"), /the Level 8 quiz/, "a failed attempt doesn't count");
  await g.retryQuiz("confidential", a);
  await quiz(g, a, "confidential", [true, true, false]);
  const card = await g.graduate(a, "Ann");
  const rec = AW.loadAward(card.id)!;
  assert.equal(rec.levels.length, 9);
  assert.equal(rec.levels[8].short, "Confidential");
  assert.equal(rec.score, 400);
  assert.equal(rec.maxScore, 410);
  const svg = AW.awardSvg(rec);
  assert.ok(svg.includes("9/9") && svg.includes("SCORE 400/410"));
  // map state agrees: all 9 switches closed only once every quiz is passed
  const ms = M.mapState(g.view(a).levels, { walletDone: true, read: [] });
  assert.equal(ms.allComplete, true);
  assert.equal(ms.doneCount, 9);
});

test("old worlds without quiz data load fine and must take the quizzes", async () => {
  const { g, any } = fakeGame();
  const a = await player(g, any);
  const p = statePath("devnet", a);
  const w = JSON.parse(readFileSync(p, "utf8"));
  delete w.quizzes;
  writeFileSync(p, JSON.stringify(w));
  const { g: g2 } = fakeGame();
  const v = g2.view(a);
  assert.equal(v.levelScore, 140);
  assert.equal(v.quizScore, 0);
  assert.ok(v.levels.every((l: any) => l.quiz && l.quiz.passed === false));
  const ms = M.mapState(v.levels, { walletDone: true, read: ["confidential"] });
  assert.equal(ms.doneCount, 0, "every switch reopens until its quiz is passed");
  await assert.rejects(g2.graduate(a, "Ann"), /Level 0 quiz/);
});

test("server: quiz routes, validation, shared world closed, own rate-limit class", async () => {
  const { g, any } = fakeGame();
  const server = createServer(createHandler(g, new RateLimiter(DEFAULT_RULES), false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    const a = await player(g, any);
    let r = await post("/api/quiz/answer", { world: a, level: "issue", q: 0, choice: wrong("issue", 0) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.correct, false);
    assert.equal(j.why, QUIZZES.issue[0].why);
    assert.ok(!JSON.stringify(j).includes('"answer"'));
    r = await post("/api/quiz/answer", { world: a, level: "issue", q: 1, choice: "x" });
    assert.equal(r.status, 400);
    r = await post("/api/quiz/retry", { world: a, level: "issue" });
    assert.equal(r.status, 200);
    process.env.DCH_SHARED_WORLD_HTTP = "0";
    r = await post("/api/quiz/answer", { level: "issue", q: 0, choice: 0 });
    assert.equal(r.status, 403);
    delete process.env.DCH_SHARED_WORLD_HTTP;
  } finally {
    delete process.env.DCH_SHARED_WORLD_HTTP;
    await new Promise((r) => server.close(r));
  }
  assert.equal(classify("POST", "/api/quiz/answer"), "quiz");
  assert.equal(classify("POST", "/api/quiz/retry"), "quiz");
});
