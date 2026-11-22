// Test-only helpers for e2e/play.mjs. The answer key lives here, outside public/, so it is
// never served to the browser; test/e2e.test.ts checks it still matches src/quizzes.ts.
import { featureEnabled, parseFeatures } from "./amendments.mjs";
/** Answer key: level id -> [question, right answer text]. Kept in sync by test/e2e.test.ts. */
export const ANSWER_KEY = {
  wallet: [
    ["What is testnet/devnet XRP worth?", "Nothing, it's free from a faucet"],
    ["What does this game send to the server?", "Only your address (r...)"],
    ["How does a new account get created?", "Someone sends it enough XRP to meet the base reserve"],
  ],
  issue: [
    ["Which wallet should have DefaultRipple turned on?", "The issuer"],
    ["Holders' trust lines should have which flag set?", "NoRipple"],
    ["A payment tries to hop through a holder whose lines are NoRipple. What happens?", "It fails, the path is dry"],
  ],
  freeze: [
    ["Who can claw back a token?", "Only the issuer, and only if it enabled clawback"],
    ["The Level 1 issuer never enabled clawback. Can it claw back TST?", "No, it's refused"],
    ["Freezing a trust line does what?", "Stops the frozen tokens from moving, except straight back to the issuer"],
  ],
  creds: [
    ["Who can accept a credential?", "Only the credential's subject"],
    ["When is a credential in force?", "After the subject accepts it"],
    ["Who creates the credential?", "The issuer"],
  ],
  domain: [
    ["Who can trade in a permissioned domain's DEX?", "Only accounts holding an accepted credential the domain lists"],
    ["A bot with no DCH-KYC credential places an offer in the domain. Result?", "It's refused"],
    ["What does Level 4 build on from Level 3?", "The DCH-KYC credential"],
  ],
  batch: [
    ["In all-or-nothing mode, one inner transaction fails. What happens?", "None of them apply"],
    ["Can the outer Batch still show tesSUCCESS when the inner ones didn't apply?", "Yes, it still pays the fee"],
    ["Why does the holder bot sign?", "It co-signs the whole batch, because one inner transaction is its own"],
  ],
  vault: [
    ["What do you get when you deposit into a vault?", "Shares"],
    ["The borrower holds no shares and tries to withdraw. Result?", "It's refused"],
    ["A holder can withdraw:", "Only against its own shares"],
  ],
  lend: [
    ["Who signs the loan?", "The lender (broker) and borrower together"],
    ["The broker's debt maximum is 20 XRP. A 25 XRP loan is tried. Result?", "It's rejected"],
    ["Where does the money lent come from?", "The lender's vault"],
  ],
  confidential: [
    ["What's an MPT held with?", "Directly in the account, no trust line"],
    ["What does ConfidentialTransfer hide from public view?", "Individual MPT balances and transfer amounts"],
    ["Can the issuer or a designated auditor still verify total supply?", "Yes"],
  ],
};

/** Where to look when a step fails: API route or step -> source file and function. */
const LEVEL_FILE = { issue: "level1.ts", freeze: "level2.ts", creds: "level3.ts", domain: "level4.ts", batch: "level5.ts", vault: "level6.ts", lend: "level7.ts" };
export function likelyCode(route, level, step) {
  const m = /^\/api\/levels\/([a-z]+)\/(goal|should-fail)/.exec(route || "");
  if (m) return `src/levels/${LEVEL_FILE[m[1]] || "index.ts"} ${m[2] === "goal" ? "runGoal" : "runShouldFail"}(); src/game.ts Game.play()`;
  const routes = {
    "/api/world/start": "src/game.ts Game.startWorld() / fundAccounts(); public/app.js walletCards() startMyWorld",
    "/api/seat/claim": "src/game.ts Game.claim(); public/level0.js claimWithWallet()",
    "/api/seat/release": "src/game.ts Game.release()",
    "/api/quiz/answer": "src/game.ts Game.answerQuiz(); src/quizzes.ts",
    "/api/quiz/retry": "src/game.ts Game.retryQuiz()",
    "/api/award": "src/game.ts Game.graduate(); src/award.ts",
    "/api/state": "src/game.ts Game.view()",
    "/api/account": "src/game.ts Game.account(); public/level0.js balance()",
  };
  if (route?.startsWith("/api/jobs/")) return "src/jobs.ts JobStore; public/app.js runLevel()";
  if (route?.startsWith("/award/")) return "src/award.ts awardPng() / awardHtml(); src/server.ts /award route";
  if (route?.includes("faucet")) return "public/level0.js fund() (browser -> faucet)";
  if (routes[route]) return routes[route];
  if (step === "graduate") return "public/app.js graduateScreen()";
  if (/^Quiz/.test(step || "")) return "public/app.js quizCards()";
  if (level === "wallet") return "public/app.js walletCards()";
  if (level === "confidential") return "public/app.js cardsFor() explainer + quizCards()";
  return "public/app.js levelScreen() / scoredCards()";
}

/** Mask anything secret-shaped and shorten addresses before it goes in a report. */
export function scrub(s) {
  return String(s ?? "")
    .replace(/\bs[1-9A-HJ-NP-Za-km-z]{24,34}\b/g, "s…[seed masked]")
    .replace(/\b(ED|00)?[0-9A-F]{64}\b/g, (h) => (h.length > 64 ? "[key masked]" : h)) // tx hashes stay; keys are longer
    .replace(/\br([1-9A-HJ-NP-Za-km-z]{24,34})\b/g, (_, x) => `r…${x.slice(-4)}`)
    .slice(0, 600);
}


/** Public JSON-RPC endpoints used to double-check amendments (read-only `feature` call). */
export const FEATURE_RPC = {
  devnet: ["https://s.devnet.rippletest.net:51234/", "https://clio.devnet.rippletest.net/"],
  testnet: ["https://s.altnet.rippletest.net:51234/", "https://clio.altnet.rippletest.net/"],
};

/**
 * What the network itself says is enabled (not the game server's possibly stale check):
 * { source, amendments } or null when no endpoint answers.
 */
export async function networkAmendments(network, fetchImpl = fetch) {
  for (const url of FEATURE_RPC[network] || []) {
    try {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "feature", params: [{}] }), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const f = j?.result?.features;
      if (f && typeof f === "object" && Object.keys(f).length) return { source: new URL(url).host, amendments: parseFeatures(f) };
    } catch { /* try the next endpoint */ }
  }
  return null;
}

/**
 * A level the game showed as "coming soon". FAIL when the network reports its feature enabled
 * (the game should have offered it); SKIPPED when the network agrees it's off, or when the
 * network couldn't be asked (then the report says so).
 */
export function skipVerdict(level, network, report) {
  if (!level.feature) return { fail: true, status: `FAIL (skipped, but Level ${level.n} needs no amendment)` };
  if (!report) return { fail: false, status: `SKIPPED (unverified: couldn't reach a ${network} server to check ${level.feature})` };
  if (featureEnabled(report, level.feature)) return { fail: true, status: `FAIL (skipped, but ${network} reports ${level.feature} enabled; the game server's amendment check is stale: Tools > Re-check)` };
  return { fail: false, status: `SKIPPED (${level.feature} not enabled on ${network})` };
}

/** Headline: PASS, "PASS (N skipped)" or FAIL. */
export function headline(pass, skipped) {
  return pass ? (skipped ? `PASS (${skipped} skipped)` : "PASS") : "FAIL";
}
