// Fact-check fixes (Nov 22 report): wording that matches xrpl.org, and every quiz keeps exactly
// three questions with one clearly correct, unique choice.
import { test } from "node:test";
import assert from "node:assert/strict";
const { QUIZZES } = await import("../src/quizzes.ts");
const { LEVELS } = await import("../src/levels/index.ts");
const D: any = await import("../public/diagrams.js" as string);

test("every quiz: 3 questions, 3 distinct choices, answer index valid", () => {
  for (const [id, qs] of Object.entries(QUIZZES)) {
    assert.equal(qs.length, 3, id);
    for (const q of qs) {
      assert.equal(q.choices.length, 3, `${id}: ${q.q}`);
      assert.equal(new Set(q.choices).size, 3, `${id}: duplicate choice`);
      assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 3, `${id}: answer index`);
      assert.ok(q.why.length > 10, `${id}: why line`);
    }
  }
});

test("fact-checked wording is in place", () => {
  const d1 = QUIZZES.domain[0];
  assert.equal(d1.choices[d1.answer], "The domain owner, plus accounts holding an accepted, unexpired credential the domain lists");
  const c1 = QUIZZES.confidential[0];
  assert.equal(c1.choices[c1.answer], "An MPToken entry the holder opts into (no trust line)");
  const c3 = QUIZZES.confidential[2];
  assert.equal(c3.q, "Who can decrypt a holder's confidential balance?");
  assert.equal(c3.choices[c3.answer], "The holder, the issuer, and an auditor if one is set");
  const dom: any = LEVELS.find((l) => l.id === "domain");
  assert.match(dom.rejectReason, /^Apart from its owner, .*unexpired credential/);
  const conf: any = LEVELS.find((l) => l.id === "confidential");
  const text = JSON.stringify(conf.explainer);
  assert.doesNotMatch(text, /held directly in an account|verify total supply/);
  assert.match(text, /Total supply stays public/);
  assert.deepEqual(D.DIAG["confidential:p3"].links, ["decrypts"]);
  assert.match(D.DIAG["freeze:goal"].caption.join(" "), /before the issuer owns anything/);
  const l1: any = LEVELS.find((l) => l.id === "issue");
  assert.ok(JSON.stringify(l1.docs ?? l1).includes("/docs/tutorials/tokens/fungible-tokens/issue-a-fungible-token"));
});
