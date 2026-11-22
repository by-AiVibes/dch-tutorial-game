import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botSeats, canAct, claimSeat, releaseSeat } from "../src/seats.ts";
import { award, judgeShouldFail, levelPoints, MAX_SCORE, total } from "../src/scoring.ts";
import { featureEnabled, parseFeatures, type AmendmentReport } from "../src/amendments.ts";
import { assertNotMainnetUrl, assertTestNetworkId, loadConfig } from "../src/config.ts";
import { LEVELS, SCORED_LEVELS } from "../src/levels/index.ts";

test("seats: bots by default, claim/move/release", () => {
  let s = botSeats();
  assert.ok(Object.values(s).every((x) => x.player === null));
  s = claimSeat(s, "issuer", "ada");
  assert.equal(s.issuer.player, "ada");
  assert.throws(() => claimSeat(s, "issuer", "bob"), /already claimed/);
  s = claimSeat(s, "holder", "ada"); // moving frees the old seat
  assert.equal(s.issuer.player, null);
  assert.equal(s.holder.player, "ada");
  assert.throws(() => releaseSeat(s, "holder", "bob"), /don't hold/);
  s = releaseSeat(s, "holder", "ada");
  assert.equal(s.holder.player, null);
  assert.throws(() => claimSeat(s, "issuer", "<script>"), /letters/);
});

test("seats: who can act", () => {
  let s = botSeats();
  assert.ok(canAct(s, ["issuer"], null), "all-bot seats: anyone may drive the demo");
  s = claimSeat(s, "issuer", "ada");
  assert.ok(canAct(s, ["issuer", "holder"], "ada"));
  assert.ok(!canAct(s, ["issuer", "holder"], "bob"));
  assert.ok(!canAct(s, ["issuer"], null));
});

test("scoring: 10 + 5 + 5 once per world, max 140", () => {
  let b = {};
  let r = award(b, "issue", "shouldFail");
  assert.equal(r.added, 5);
  r = award(r.board, "issue", "goal");
  assert.equal(r.added, 15, "goal plus full-level bonus");
  const again = award(r.board, "issue", "goal");
  assert.equal(again.added, 0);
  assert.equal(total(r.board), 20);
  assert.equal(levelPoints(undefined), 0);
  assert.equal(MAX_SCORE, 140);
  assert.equal(SCORED_LEVELS.length, 7);
});

test("should-fail judge: only rejections score; acceptance is flagged", () => {
  assert.deepEqual(judgeShouldFail("tecPATH_DRY", ["tecPATH_DRY"]), { rejected: true, matchedExpected: true, bug: false });
  assert.equal(judgeShouldFail("temBAD_AMOUNT", ["tecPATH_DRY"]).matchedExpected, false);
  assert.equal(judgeShouldFail("tesSUCCESS", ["tecPATH_DRY"]).bug, true);
});

test("amendments: coming soon unless every required amendment is enabled", () => {
  const amendments = parseFeatures({
    a: { name: "SingleAssetVault", enabled: true },
    b: { name: "LendingProtocol", enabled: false },
    c: { name: "BatchV1_1", enabled: true },
  });
  const rep: AmendmentReport = { checkedAt: "", network: "testnet", amendments };
  assert.ok(featureEnabled(rep, "SingleAssetVault"));
  assert.ok(!featureEnabled(rep, "LendingProtocol"));
  assert.ok(featureEnabled(rep, "Batch"), "any-of alternative names");
  assert.ok(!featureEnabled(rep, "Credentials"));
  assert.ok(!featureEnabled(null, "SingleAssetVault"));
});

test("config: mainnet is refused", () => {
  assert.throws(() => assertNotMainnetUrl("wss://xrplcluster.com"));
  assert.throws(() => assertNotMainnetUrl("wss://s1.ripple.com"));
  assert.throws(() => assertTestNetworkId(0, 1));
  assert.throws(() => assertTestNetworkId(undefined, 1));
  assert.throws(() => assertTestNetworkId(2, 1));
  assert.doesNotThrow(() => assertTestNetworkId(1, 1));
  assert.throws(() => loadConfig({ XRPL_NETWORK: "mainnet" }));
  assert.throws(() => loadConfig({ XRPL_WS: "wss://s2.ripple.com" }));
  assert.equal(loadConfig({}).name, "testnet");
});

test("levels: every level links xrpl.org docs; priority levels present", () => {
  for (const l of LEVELS) {
    assert.ok(l.docs.length > 0 && l.docs.every((d) => d.href.startsWith("https://xrpl.org/")), l.id);
  }
  assert.deepEqual(LEVELS.filter((l) => l.priority).map((l) => l.id), ["vault", "lend", "confidential"]);
});

test("store: public view never contains seeds", async () => {
  process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-"));
  const { emptyWorld, publicView } = await import("../src/store.ts");
  const w = emptyWorld("testnet");
  w.accounts.issuer = { address: "rTEST", seed: "sSECRET" };
  const json = JSON.stringify(publicView(w));
  assert.ok(json.includes("rTEST"));
  assert.ok(!json.includes("sSECRET") && !json.includes("seed"));
});
