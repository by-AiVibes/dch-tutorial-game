// The e2e playthrough's answer key and report helpers (e2e/lib.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
const { QUIZZES } = await import("../src/quizzes.ts");
const E: any = await import("../e2e/lib.mjs" as string);

test("e2e answer key matches the server's quizzes (question text and right answer)", () => {
  assert.deepEqual(Object.keys(E.ANSWER_KEY).sort(), Object.keys(QUIZZES).sort());
  for (const [id, qs] of Object.entries(QUIZZES)) {
    assert.deepEqual(E.ANSWER_KEY[id], qs.map((q) => [q.q, q.choices[q.answer]]), `answer key drifted for ${id}`);
  }
});
test("the answer key is never in the client bundle", () => {
  const pub = new URL("../public/", import.meta.url);
  const client = readdirSync(pub).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => readFileSync(new URL(f, pub), "utf8")).join("\n");
  for (const qs of Object.values(QUIZZES)) for (const q of qs) {
    assert.equal(client.includes(q.q), false, `question text in client: ${q.q}`);
  }
  assert.equal(client.includes("ANSWER_KEY"), false);
});
test("e2e reports mask seeds and shorten addresses", () => {
  const s = E.scrub("seed sEdTM1uX8pu2do5XvTnutH6HsouMaM2 and snoPBrXtMeMyMHUVTgbuqAfg1SUTb for rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
  assert.doesNotMatch(s, /sEdTM1uX8pu2do5XvTnutH6HsouMaM2|snoPBrXtMeMyMHUVTgbuqAfg1SUTb|rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh/);
  assert.match(s, /r…tyTh/);
});
test("e2e likely-code hints map routes to source", () => {
  assert.match(E.likelyCode("/api/levels/lend/should-fail"), /src\/levels\/level7\.ts runShouldFail/);
  assert.match(E.likelyCode("/api/levels/issue/goal"), /level1\.ts runGoal/);
  assert.match(E.likelyCode("/api/quiz/answer"), /answerQuiz/);
  assert.match(E.likelyCode("/api/jobs/abc"), /jobs\.ts/);
  assert.match(E.likelyCode("", "wallet", "Fund it"), /walletCards/);
  assert.match(E.likelyCode("", "freeze", "Quiz 1 of 3"), /quizCards/);
});
