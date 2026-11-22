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

test("e2e: a skipped level FAILs when the network reports its amendment enabled; else SKIPPED", () => {
  const on = { amendments: { MPTokensV1: { enabled: true }, SingleAssetVault: { enabled: true }, LendingProtocol: { enabled: true }, BatchV1_1: { enabled: false } } };
  const lend = { n: 7, id: "lend", feature: "LendingProtocol" }, batch = { n: 5, id: "batch", feature: "Batch" };
  const v1 = E.skipVerdict(lend, "devnet", on);
  assert.equal(v1.fail, true);
  assert.match(v1.status, /^FAIL \(skipped, but devnet reports LendingProtocol enabled/);
  const v2 = E.skipVerdict(batch, "devnet", on);
  assert.deepEqual(v2, { fail: false, status: "SKIPPED (Batch not enabled on devnet)" });
  assert.match(E.skipVerdict(batch, "devnet", null).status, /^SKIPPED \(unverified/);
  assert.equal(E.skipVerdict({ n: 1, id: "issue", feature: null }, "devnet", on).fail, true, "levels with no amendment can't be skipped");
});
test("e2e: headline says how many levels were skipped; never a silent PASS", () => {
  assert.equal(E.headline(true, 0), "PASS");
  assert.equal(E.headline(true, 2), "PASS (2 skipped)");
  assert.equal(E.headline(false, 2), "FAIL");
  const play = readFileSync(new URL("../e2e/play.mjs", import.meta.url), "utf8");
  assert.match(play, /`DCH e2e: \$\{headline\(overall === "PASS", maxSkipped\)\}`/);
  assert.match(play, /RUN \$\{i \+ 1\}: \$\{headline\(runOk\(r\), skippedIn\(r\)\)\}/);
});
test("e2e: asks the network itself, trying the next endpoint when one fails", async () => {
  const calls: string[] = [];
  const fake = async (url: string) => {
    calls.push(url);
    if (calls.length === 1) throw new Error("ECONNREFUSED");
    return { json: async () => ({ result: { features: { H1: { name: "Batch", enabled: false }, H2: { name: "Clawback", enabled: true } } } }) };
  };
  const r = await E.networkAmendments("devnet", fake);
  assert.equal(calls.length, 2);
  assert.equal(r.source, "clio.devnet.rippletest.net");
  assert.equal(r.amendments.Clawback.enabled, true);
  assert.equal(await E.networkAmendments("mainnet", fake), null, "no mainnet endpoints, ever");
});
