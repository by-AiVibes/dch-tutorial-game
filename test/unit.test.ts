import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botSeats, canAct, claimSeat, releaseSeat } from "../src/seats.ts";
import { award, judgeShouldFail, levelPoints, MAX_SCORE, total } from "../src/scoring.ts";
import { featureEnabled, parseFeatures, type AmendmentReport } from "../src/amendments.ts";
import { assertAllowedHost, assertTestNetworkId, loadConfig } from "../src/config.ts";
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

test("should-fail judge: only final rejections score", () => {
  assert.deepEqual(judgeShouldFail("tecPATH_DRY", true, ["tecPATH_DRY"]), { verdict: "rejected", matchedExpected: true });
  assert.equal(judgeShouldFail("tecPATH_DRY", false, ["tecPATH_DRY"]).verdict, "inconclusive", "unvalidated tec");
  assert.equal(judgeShouldFail("temBAD_AMOUNT", false, ["tecPATH_DRY"]).verdict, "rejected");
  assert.equal(judgeShouldFail("tefPAST_SEQ", false, []).verdict, "rejected");
  assert.equal(judgeShouldFail("telINSUF_FEE_P", false, []).verdict, "rejected");
  assert.equal(judgeShouldFail("temBAD_AMOUNT", false, ["tecPATH_DRY"]).matchedExpected, false);
  assert.equal(judgeShouldFail("terQUEUED", false, []).verdict, "inconclusive");
  assert.equal(judgeShouldFail("submitError", false, []).verdict, "inconclusive");
  assert.equal(judgeShouldFail("unknown", true, []).verdict, "inconclusive");
  assert.equal(judgeShouldFail("tesSUCCESS", true, []).verdict, "accepted");
  assert.equal(judgeShouldFail("tesSUCCESS", false, []).verdict, "inconclusive");
});

test("amendments: coming soon unless every required amendment is enabled", () => {
  const amendments = parseFeatures({
    a: { name: "SingleAssetVault", enabled: true },
    m: { name: "MPTokensV1", enabled: true },
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
  assert.throws(() => assertAllowedHost("wss://xrplcluster.com"));
  assert.throws(() => assertAllowedHost("wss://s1.ripple.com"));
  assert.throws(() => assertAllowedHost("wss://testnet.xrpl-labs.com.evil.example"));
  assert.throws(() => assertAllowedHost("not a url"));
  assert.doesNotThrow(() => assertAllowedHost("wss://testnet.xrpl-labs.com"));
  assert.doesNotThrow(() => assertAllowedHost("wss://s.devnet.rippletest.net:51233"));
  assert.doesNotThrow(() => assertAllowedHost("faucet.altnet.rippletest.net"));
  assert.throws(() => loadConfig({ XRPL_WS: "wss://my-node.example.com" }), /not a known/);
  assert.throws(() => assertTestNetworkId(0, 1));
  assert.throws(() => assertTestNetworkId(undefined, 1));
  assert.throws(() => assertTestNetworkId(2, 1));
  assert.doesNotThrow(() => assertTestNetworkId(1, 1));
  assert.throws(() => loadConfig({ XRPL_NETWORK: "mainnet" }));
  assert.throws(() => loadConfig({ XRPL_WS: "wss://s2.ripple.com" }));
  assert.equal(loadConfig({}).name, "devnet");
  assert.equal(loadConfig({ XRPL_NETWORK: "testnet" }).name, "testnet");
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

test("levels: interactive runners where expected", () => {
  const live = LEVELS.filter((l) => l.runGoal && l.runShouldFail).map((l) => l.id);
  assert.deepEqual(live, ["issue", "freeze", "creds", "domain", "batch", "vault", "lend"]);
  assert.ok(LEVELS.find((l) => l.id === "confidential")?.explainer?.length);
});

test("dashboard summaries are short and secret-free", async () => {
  const { summarize } = await import("../src/game.ts");
  assert.equal(summarize({ LedgerEntryType: "Credential", CredentialType: Buffer.from("DCH-KYC").toString("hex"), Flags: 0x10000 }), "DCH-KYC accepted");
  assert.equal(summarize({ LedgerEntryType: "Loan", PaymentRemaining: 0 }), "payments remaining 0");
  assert.equal(summarize({ LedgerEntryType: "Offer", DomainID: "AB" }), "in domain");
});

test("amendments: vault gate also needs MPTokensV1", () => {
  const rep: AmendmentReport = { checkedAt: "", network: "devnet", amendments: parseFeatures({ a: { name: "SingleAssetVault", enabled: true } }) };
  assert.ok(!featureEnabled(rep, "SingleAssetVault"));
});
