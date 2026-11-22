#!/usr/bin/env node
// End-to-end playthrough of the DCH Tutorial Game, the way a phone player plays it.
//
//   npm run e2e -- --url http://127.0.0.1:8790
//   npm run e2e -- --url https://your-game-host.example
//
// Playwright headless Chromium at iPhone size (375x667, Mobile Safari user agent), macOS or
// Linux, Node 20+ (plain JS, no TypeScript imports: the server's 22.18 isn't needed here).
// Test networks only: it reads /api/state first and stops unless the server
// says devnet or testnet. It never opens a wallet app; the game page makes a throwaway test
// wallet in the browser, and only that wallet's ADDRESS is kept (in ./.e2e-player.json) so later
// runs reuse the same world (the server allows 3 new worlds per hour per IP). No seed is stored.
//
// It presses what the flashing arrow points at, else Next, answers each quiz from the answer key
// in e2e/lib.mjs (test-only; the game never sends answers to the browser), and writes:
//   ./e2e-out/report.md    short plain summary: overall result, fails, one line per level
//   ./e2e-out/report.json  every step: level, step, PASS/FAIL, time, on-screen error, API route +
//                          HTTP status + server error, console errors, screenshot, likely code
//   ./e2e-out/NNN-*.png    a screenshot per step
// Exit code: 0 all PASS, 1 any FAIL, 2 bad setup (not a test network, server down, bad option).
//
// Options:
//   --url <base>       game URL (default http://localhost:8790)
//   --runs <N>         play N times in a row, reusing one world (default 1)
//   --level <K>        test only Level K (0-8); earlier unfinished levels are played first as setup
//   --fresh            start a new wallet + world instead of reusing ./.e2e-player.json
//   --wrong <levelId>  answer that level's first quiz question wrong (tests the "why" line)
//   --latency <ms>     add this delay to every game API call (tests slow networks)
//   --out <dir>        output folder (default ./e2e-out)   --headed   --max-minutes <n> (default 30 per run)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ANSWER_KEY, headline, likelyCode, networkAmendments, scrub, skipVerdict } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : dflt; };
const BASE = String(opt("url", "http://localhost:8790")).replace(/\/$/, "");
const OUT = resolve(String(opt("out", "./e2e-out")));
const PLAYER_FILE = resolve(".e2e-player.json");
const HEADED = !!opt("headed", false);
const FRESH = !!opt("fresh", false);
const WRONG = opt("wrong", "");
const RUNS = Number(opt("runs", 1));
const ONLY = opt("level", null) === null ? null : Number(opt("level"));
const MAX_MS = Number(opt("max-minutes", 30)) * 60_000;
const LATENCY = Number(opt("latency", 0)); // ms added to every game API call (simulates a slow phone network)
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 20 || (ONLY !== null && !(Number.isInteger(ONLY) && ONLY >= 0 && ONLY <= 8))) {
  console.error("Usage: npm run e2e -- --url <game url> [--runs 1-20] [--level 0-8] [--fresh] [--wrong <levelId>]");
  process.exit(2);
}
// The e2e is plain JS (no TypeScript imports), so any Node that Playwright supports works.
const [major] = process.versions.node.split(".").map(Number);
if (major < 20) { console.error(`Node 20 or newer is needed for the e2e (this is ${process.versions.node}).`); process.exit(2); }

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { console.error("Playwright is missing. First run:  npm ci && npx playwright install chromium"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (s) => console.log(`${stamp()} ${s}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---- setup: server up, test network only ----
let st;
try { st = await (await fetch(`${BASE}/api/state`)).json(); }
catch (e) { console.error(`SETUP FAIL: can't reach ${BASE}/api/state (${e.message})`); writeFileSync(join(OUT, "report.md"), `DCH e2e: FAIL (setup)\nCan't reach ${BASE}.\n`); process.exit(2); }
if (!["devnet", "testnet"].includes(st.network)) {
  console.error(`SETUP FAIL: server network is "${st.network}"; this script only plays devnet or testnet.`);
  writeFileSync(join(OUT, "report.md"), `DCH e2e: FAIL (setup)\nServer network is ${st.network}, not a test network. Nothing was played.\n`);
  process.exit(2);
}
// All levels: a server that just started may not have checked its amendments yet, so availability
// is read from the player's own world at the end of each run (unavailable = skipped, not failed).
const LEVELS = [...st.levels].sort((a, b) => a.n - b.n);
const target = ONLY === null ? null : LEVELS.find((l) => l.n === ONLY);
if (ONLY !== null && !target) { console.error(`Level ${ONLY} isn't playable on ${st.network} right now.`); process.exit(2); }

// ---- the reused player (address only) ----
let saved = null;
try { const j = JSON.parse(readFileSync(PLAYER_FILE, "utf8")); if (j.url === BASE && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(j.address)) saved = j; } catch { /* none yet */ }
if (FRESH) saved = null;

const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({
  viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1 DCH-e2e", // DCH-e2e: excluded from visitor/player stats
});
const page = await ctx.newPage();
if (LATENCY > 0) await page.route(`${BASE}/api/**`, async (r) => { await sleep(LATENCY); await r.continue(); });
let apiLog = [], consoleLog = [], shotN = 0;
page.on("console", (m) => { if (m.type() === "error") consoleLog.push(scrub(m.text())); });
page.on("pageerror", (e) => consoleLog.push(scrub(e.message)));
page.on("response", async (r) => {
  const u = new URL(r.url());
  const route = u.origin === new URL(BASE).origin ? u.pathname : `${u.host}${u.pathname}`;
  if (!route.startsWith("/api/") && !route.startsWith("/award/") && !route.includes("faucet")) return;
  const e = { route: route.replace(/\/api\/account\/[^/]+/, "/api/account").replace(/\/api\/jobs\/[^/]+/, "/api/jobs/<id>").replace(/\/award\/[^/.]+/, "/award/<id>"), method: r.request().method(), status: r.status() };
  if (r.status() >= 400) { try { const j = await r.json(); e.error = scrub(j.error || JSON.stringify(j)); } catch { e.error = r.statusText(); } }
  apiLog.push(e);
});
page.on("requestfailed", (q) => { const u = new URL(q.url()); apiLog.push({ route: u.pathname, method: q.method(), status: 0, error: scrub(q.failure()?.errorText || "request failed") }); });

async function shot(name) {
  const f = join(OUT, `${String(++shotN).padStart(3, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.png`);
  await page.screenshot({ path: f }).catch(() => {});
  return f.slice(OUT.length + 1);
}
const read = () => page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const t = q(".target");
  const n = q('[data-pt^="next-"]');
  return {
    hash: location.hash, title: q("#cardtitle")?.textContent || q(".maphead h1")?.textContent || q(".card h2")?.textContent || "",
    hint: q("#hint")?.textContent || "", target: t?.dataset.pt || null, score: [...document.querySelectorAll("#stats .pill b")].map((b) => b.textContent).join(" | "),
    busy: !!q(".spinner") || !!document.body.dataset.busy, bad: [...document.querySelectorAll(".result.bad")].map((x) => x.textContent).join(" / "),
    lead: q(".card .lead")?.textContent || "",
    choices: [...document.querySelectorAll(".choice")].map((b) => ({ pt: b.dataset.pt, text: b.textContent, disabled: b.disabled })),
    next: n ? { pt: n.dataset.pt, text: n.textContent, off: n.disabled || n.getAttribute("aria-disabled") === "true" } : null,
    img: !!(q(".award-img")?.complete && q(".award-img")?.naturalWidth),
    address: localStorage.getItem("dch-wallet-address") || "",
  };
});
const click = (pt) => page.locator(`[data-pt="${pt}"]`).first().click({ timeout: 10_000 });
const levelOf = (hash) => (hash.startsWith("#/level/") ? hash.slice(8) : hash === "#/graduate" ? "graduate" : "map");

/** One full run: returns { steps, levels, graduated }. */
async function playOnce(run) {
  const t0 = Date.now();
  const steps = [];
  const levels = Object.fromEntries(LEVELS.map((l) => [l.id, { n: l.n, title: l.title, status: "NOT REACHED", ms: 0, errors: [], setup: target ? l.n < target.n : false }]));
  let graduated = false;
  const record = async (s, action, fail, errorText, extra = {}) => {
    const level = levelOf(s.hash);
    const rec = { run, level, step: s.title, action, result: fail ? "FAIL" : "PASS", ms: extra.ms ?? 0, score: s.score, screenError: errorText || null,
      api: extra.api || [], consoleErrors: extra.console || [], shot: await shot(`r${run}-${level}-${s.title}-${fail ? "FAIL" : action}`),
      ...(fail ? { likelyCode: likelyCode(extra.route || "", level, s.title) } : {}) };
    steps.push(rec);
    if (levels[level]) { levels[level].ms += rec.ms; if (fail) levels[level].errors.push(`${s.title}: ${errorText}`); }
    say(`${rec.result} run ${run} ${level} «${s.title}» ${action} ${rec.ms} ms${errorText ? " :: " + errorText : ""}`);
    return rec;
  };
  async function step(s, action, fn) {
    apiLog = []; consoleLog = [];
    const t = Date.now();
    let err = "";
    try { await fn(); } catch (e) { err = scrub(e.message.split("\n")[0]); }
    let after = await read().catch(() => s);
    while (after.busy && Date.now() - t < 10 * 60_000) { await sleep(1000); after = await read().catch(() => after); }
    await sleep(250);
    after = await read().catch(() => after);
    const apiFails = apiLog.filter((a) => a.status === 0 || a.status >= 400);
    const screenErr = after.bad && !/^Not quite/.test(after.bad) ? scrub(after.bad) : "";
    const errorText = err || screenErr || apiFails.map((a) => `${a.method} ${a.route} ${a.status} ${a.error || ""}`.trim()).join("; ");
    const level = levelOf(s.hash);
    const route = apiFails[0]?.route || (/^run-(goal|fail)$/.test(action) ? `/api/levels/${level}/${action === "run-goal" ? "goal" : "should-fail"}` : "");
    // A 429 means we went too fast: wait as told and don't count it as a game bug.
    const limited = apiLog.find((a) => a.status === 429);
    if (limited) { say(`rate limited on ${limited.route}; waiting 60 s`); await sleep(60_000); }
    await record(s, action, !!errorText && !limited, errorText, { ms: Date.now() - t, api: apiLog.map((a) => ({ ...a })), console: [...consoleLog], route });
    return after;
  }

  await page.goto(`${BASE}/#/map`);
  if (run === 1) {
    await page.evaluate((addr) => { localStorage.clear(); if (addr) localStorage.setItem("dch-wallet-address", addr); }, saved?.address || "");
    say(saved ? `reusing world ${saved.address.slice(0, 5)}… (from ${PLAYER_FILE})` : "new wallet and world");
  }
  await page.reload(); await sleep(1200);
  if (target) {
    // Open Level K directly. If it's locked the game shows "Locked" and points at the first
    // unfinished level, which this run plays first (as setup) until it reaches Level K.
    await page.evaluate((id) => { const k = "dch-ui-v2"; const u = JSON.parse(localStorage.getItem(k) || "{}"); u.step = { ...(u.step || {}), [id]: 0 }; localStorage.setItem(k, JSON.stringify(u)); location.hash = `#/level/${id}`; }, target.id);
    await sleep(800);
  }

  let last = "", same = 0, wrongDone = false;
  while (Date.now() - t0 < MAX_MS) {
    const s = await read();
    if (s.address && (!saved || saved.address !== s.address)) { saved = { url: BASE, address: s.address, createdAt: new Date().toISOString() }; writeFileSync(PLAYER_FILE, JSON.stringify(saved, null, 2) + "\n"); }
    const lvl = levelOf(s.hash);
    if (levels[lvl] && levels[lvl].status === "NOT REACHED") levels[lvl].status = "IN PROGRESS";
    if (/^(Switch closed|Wallet ready) ✓/.test(s.title) && levels[lvl] && !/PASS|FAIL/.test(levels[lvl].status)) {
      // closing card reached this run
      levels[lvl].status = levels[lvl].errors.length ? "FAIL" : "PASS";
      say(`== run ${run} Level ${levels[lvl].n} ${lvl}: ${levels[lvl].status}`);
      if (target && lvl === target.id) break; // --level K: done
    }
    const key = `${s.hash}|${s.title}|${s.hint}|${s.bad}|${s.choices.filter((c) => !c.disabled).length}`;
    if (key === last) {
      if (++same >= 3) {
        await record(s, "stuck", true, `stuck: "${scrub(s.hint)}"${s.bad ? " / " + scrub(s.bad) : ""}`);
        if (levels[lvl]) levels[lvl].status = "FAIL";
        break;
      }
    } else { same = 0; last = key; }

    if (s.hash === "#/graduate") {
      if (target) break;
      if (s.target === "make-card") { await page.fill("#grad-name", "e2e player"); await step(s, "make-card", () => click("make-card")); continue; }
      let ok = s.img;
      for (let w = 0; w < 20 && !ok; w++) { await sleep(500); ok = (await read()).img; }
      await page.locator(".award-img").scrollIntoViewIfNeeded().catch(() => {});
      await record(s, "award card", !ok, ok ? "" : "award card image did not load", { route: "/award/" });
      graduated = ok;
      break;
    }
    // Replay of a finished world: the map offers the graduate card; go there.
    if (s.hash === "#/map" && s.target === "graduate") { await step(s, "graduate", () => click("graduate")); continue; }
    const open = s.choices.filter((c) => !c.disabled);
    if (open.length) {
      const qs = ANSWER_KEY[lvl] || [];
      const hit = qs.findIndex(([q]) => q === s.lead);
      if (hit < 0) { await record(s, "quiz", true, `question not in the e2e answer key: "${scrub(s.lead)}"`, { route: "/api/quiz/answer" }); break; }
      const rightText = qs[hit][1];
      let pick = s.choices.find((c) => c.text.replace(/^[✓✗] /, "") === rightText);
      if (WRONG === lvl && !wrongDone && hit === 0) { wrongDone = true; pick = s.choices.find((c) => c !== pick); }
      if (!pick) { await record(s, "quiz", true, `right answer "${rightText}" not among the choices`, { route: "/api/quiz/answer" }); break; }
      await step(s, `answer Q${hit + 1}`, () => click(pick.pt));
      continue;
    }
    if (s.target) { await step(s, s.target, () => click(s.target)); continue; }
    if (s.next && !s.next.off) { await step(s, "next", () => click(s.next.pt)); continue; }
    // Nothing to press right now: give a slow response a moment before calling it a dead end.
    let later = s;
    for (let w = 0; w < 20 && !later.target && !(later.next && !later.next.off) && !later.choices.some((c) => !c.disabled); w++) { await sleep(500); later = await read(); }
    if (later.target || (later.next && !later.next.off) || later.choices.some((c) => !c.disabled)) continue;
    await record(later, "dead end", true, `nothing to press after 10 s (hint: "${scrub(later.hint)}")`);
    break;
  }
  if (Date.now() - t0 >= MAX_MS) steps.push({ run, level: "run", step: "timeout", action: "timeout", result: "FAIL", ms: MAX_MS, screenError: `run took over ${MAX_MS / 60000} minutes`, api: [], consoleErrors: [], shot: await shot("TIMEOUT"), likelyCode: "see the last step" });
  // Levels already closed in a reused world are passed before this run started.
  const view = await (await fetch(`${BASE}/api/state?world=${encodeURIComponent(saved?.address || "")}`)).json().catch(() => null);
  for (const l of view?.levels || []) {
    const r = levels[l.id];
    if (r && l.available === false) {
      netReport ??= await networkAmendments(st.network);
      const v = skipVerdict(l, st.network, netReport);
      r.status = v.status; r.skipped = !v.fail;
      if (v.fail) {
        r.errors.push(v.status);
        steps.push({ run, level: l.id, step: "coming soon", action: "skip check", result: "FAIL", ms: 0, score: "", screenError: v.status, api: [], consoleErrors: [], shot: "", likelyCode: "src/amendments.ts featureEnabled() (copy: e2e/amendments.mjs); src/game.ts levelAvailable() / refreshAmendments()" });
      }
      continue;
    }
    if (r && r.status !== "FAIL" && !r.errors.length && (l.quiz ? l.quiz.passed : true) && (l.n === 0 || l.n === 8 || (l.score.goal && l.score.shouldFail))) r.status = r.status === "NOT REACHED" ? "PASS (done earlier in this world)" : "PASS";
  }
  return { steps, levels, graduated, seconds: Math.round((Date.now() - t0) / 1000), score: view ? `${view.score}/${view.maxScore}` : "?" };
}

let netReport; // what the network itself reports (only fetched if a level was skipped)

// ---- runs ----
const results = [];
let crash = null;
try {
  for (let run = 1; run <= RUNS; run++) {
    say(`run ${run}/${RUNS} on ${BASE} (${st.network})${target ? `, Level ${target.n} only` : ""}`);
    results.push(await playOnce(run));
    if (run < RUNS) { say("pausing 30 s between runs (rate limits)"); await sleep(30_000); }
  }
} catch (e) { crash = scrub(e.message); say(`CRASH ${crash}`); }
await browser.close().catch(() => {});

// ---- reports ----
const allSteps = results.flatMap((r) => r.steps);
const fails = allSteps.filter((s) => s.result === "FAIL");
const levelPass = (r, l) => (r.levels[l.id].setup ? true : /^(PASS|SKIPPED)/.test(r.levels[l.id].status));
const skippedIn = (r) => LEVELS.filter((l) => (!target || l.id === target.id) && r.levels[l.id].skipped).length;
const maxSkipped = Math.max(0, ...results.map(skippedIn));
const runOk = (r) => LEVELS.every((l) => (target && l.id !== target.id) || levelPass(r, l)) && (target ? true : r.graduated);
const overall = !crash && results.length === RUNS && results.every(runOk) && fails.length === 0 ? "PASS" : "FAIL";
writeFileSync(join(OUT, "report.json"), JSON.stringify({
  tool: "dch e2e playthrough", url: BASE, network: st.network, overall: headline(overall === "PASS", maxSkipped), skipped: maxSkipped, runs: RUNS, level: target ? target.n : null, crash,
  results: results.map((r, i) => ({ run: i + 1, seconds: r.seconds, score: r.score, graduated: r.graduated, levels: Object.entries(r.levels).map(([id, l]) => ({ id, ...l })) })),
  fails, steps: allSteps,
}, null, 2));
const lines = [
  `DCH e2e: ${headline(overall === "PASS", maxSkipped)}`,
  `URL: ${BASE} (${st.network}). Runs: ${RUNS}.${target ? ` Level ${target.n} only.` : ""} ${new Date().toISOString().slice(0, 16)} UTC.`,
  crash ? `Crash: ${crash}` : null,
  "",
  `FAILS (${fails.length}):`,
  ...(fails.length ? fails.map((f, i) => `${i + 1}. Run ${f.run}, ${f.level}, "${f.step}" (${f.action}): ${f.screenError || "failed"}` +
    `${f.api?.filter((a) => a.status === 0 || a.status >= 400).map((a) => ` | API ${a.method} ${a.route} -> ${a.status} ${a.error || ""}`.trimEnd()).join("") || ""}` +
    `${f.consoleErrors?.length ? ` | console: ${f.consoleErrors.slice(0, 2).join("; ")}` : ""}` +
    ` | likely code: ${f.likelyCode} | screenshot: ${f.shot}`) : ["none"]),
  "",
  ...results.flatMap((r, i) => [
    `RUN ${i + 1}: ${headline(runOk(r), skippedIn(r))}, ${r.seconds} s, score ${r.score}, graduate card ${target ? "not tested" : r.graduated ? "PASS" : "FAIL"}`,
    ...LEVELS.filter((l) => !target || l.id === target.id).map((l) => {
      const x = r.levels[l.id];
      const ok = /^(PASS|SKIPPED)/.test(x.status);
      return `Level ${l.n} ${l.id}: ${ok ? x.status : "FAIL"}${!ok && x.status !== "FAIL" ? ` (${x.status.toLowerCase()})` : ""}, ${Math.round(x.ms / 1000)} s${x.errors.length ? ` | ${x.errors[0]}` : ""}`;
    }),
  ]),
  "",
  "Details: report.json (every step, API calls, console errors). No seeds or secrets are recorded.",
].filter((x) => x !== null);
writeFileSync(join(OUT, "report.md"), lines.join("\n") + "\n");
console.log("\n" + lines.join("\n"));
process.exit(crash ? 1 : overall === "PASS" ? 0 : 1);
