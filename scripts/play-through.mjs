// Headless "real player" (Chrome via DevTools protocol, no extra deps): plays the game from
// Level 0 to the graduation card at 375px like a person would: it presses whatever the flashing
// pointer points at, otherwise Next, answers quizzes, and logs every screen. It flags stuck
// screens, error results and pointer-less dead ends. Uses devnet test accounts only.
//   BASE=https://… SHOTS=/dir [SKIPTEST=1] [WRONG=freeze] node scripts/play-through.mjs
// SKIPTEST=1 first tries to skip Level 1's steps with Next (a real-player shortcut) and logs
// what the game allows. WRONG=<level> answers that level's first quiz question wrong.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const BASE = process.env.BASE || "http://localhost:8790";
const SHOTS = process.env.SHOTS || "";
const VH = Number(process.env.VH || 667);
const MAX_STEPS = Number(process.env.MAX_STEPS || 500);
const { QUIZZES } = await import(new URL("../src/quizzes.ts", import.meta.url).href);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const port = 9400 + Math.floor(Math.random() * 400);
const prof = process.env.PROFILE || `/tmp/chr-profile-play-${process.pid}`; // PROFILE=dir resumes a player
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.find((t) => t.type === "page")) break; } catch {} await sleep(250); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map(); const errors = [];
ws.addEventListener("message", (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } else if (j.method === "Runtime.exceptionThrown") errors.push(j.params.exceptionDetails.exception?.description); else if (j.method === "Log.entryAdded" && j.params.entry.level === "error") errors.push(j.params.entry.text); });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
let shotN = 0;
const shot = async (name) => { if (!SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); const f = `${SHOTS}/${String(++shotN).padStart(3, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`; writeFileSync(f, Buffer.from(r.result.data, "base64")); return f; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const findings = [];
const flag = async (kind, msg) => { const f = await shot(kind + "-" + msg); findings.push({ kind, msg, shot: f }); log("FLAG", kind, msg, f || ""); };

// Test networks only: refuse anything that isn't devnet or testnet before touching the page.
const net = await fetch(`${BASE}/api/state`).then((r) => r.json()).then((j) => j.network, () => null);
if (!["devnet", "testnet"].includes(net)) { console.error(`refusing: ${BASE} reports network ${JSON.stringify(net)} (devnet/testnet only)`); chrome.kill(); process.exit(2); }
await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
await send("Network.enable"); await send("Network.setUserAgentOverride", { userAgent: UA, platform: "iPhone" });
await send("Emulation.setDeviceMetricsOverride", { width: 375, height: VH, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true });
await send("Page.navigate", { url: BASE + "/" }); await sleep(1500);
if (!process.env.PROFILE) await ev(`localStorage.clear(); true`);
if (process.env.STEPS) await ev(`(() => { const k = "dch-ui-v2"; const u = JSON.parse(localStorage.getItem(k) || "{}"); u.step = { ...(u.step || {}), ...${process.env.STEPS} }; localStorage.setItem(k, JSON.stringify(u)); return true; })()`);
await send("Page.navigate", { url: BASE + "/#/map" }); await sleep(300); await send("Page.reload"); await sleep(1500);

const read = () => ev(`(() => {
  const q = (s) => document.querySelector(s);
  const t = q(".target");
  return {
    hash: location.hash, title: q("#cardtitle")?.textContent || q(".maphead h1")?.textContent || q(".card h2")?.textContent || "",
    crumbs: q(".crumbs span")?.textContent || "", hint: q("#hint")?.textContent || "", target: t?.dataset.pt || null,
    stats: [...document.querySelectorAll("#stats .pill b")].map((b) => b.textContent).join(" | "),
    busy: !!q(".spinner") || !!document.body.dataset.busy, bad: [...document.querySelectorAll(".result.bad")].map((x) => x.textContent).join(" / ").slice(0, 240),
    lead: q(".card .lead")?.textContent?.slice(0, 160) || q(".maphead p")?.textContent || "",
    choices: [...document.querySelectorAll(".choice")].map((b) => ({ pt: b.dataset.pt, text: b.textContent, disabled: b.disabled })),
    next: (() => { const n = q('[data-pt^="next-"]'); return n ? { pt: n.dataset.pt, text: n.textContent, disabled: n.disabled || n.getAttribute("aria-disabled") === "true" } : null; })(),
    graduate: location.hash === "#/graduate", img: !!q(".award-img")?.naturalWidth,
  };
})()`);
const click = (pt) => ev(`(() => { const e = document.querySelector('[data-pt="${pt}"]'); if (!e) return false; e.click(); return true; })()`);

let last = "", same = 0, skipped = 0, wrongDone = false, steps = 0, seen = new Set();
const t0 = Date.now();
try {
  while (steps++ < MAX_STEPS) {
    await sleep(700);
    let s = await read();
    for (let w = 0; s.busy && w < 480; w++) { await sleep(1000); s = await read(); } // ledger work (Level 7 waits ~4 min)
    const key = `${s.hash}|${s.title}|${s.hint}|${s.bad}`;
    if (!seen.has(s.hash + s.title)) { seen.add(s.hash + s.title); await shot(`${s.hash.replace("#/", "")}-${s.title}`); }
    log(`[${s.stats}] ${s.hash} «${s.title}» hint="${s.hint}" target=${s.target}${s.bad ? " BAD=" + s.bad : ""}`);
    if (key === last) { if (++same >= 4) { await flag("stuck", `${s.hash} ${s.title}`); break; } } else { same = 0; last = key; }
    if (s.bad && !/Not quite/.test(s.bad)) await flag("error", `${s.hash} ${s.title}: ${s.bad}`);

    if (s.graduate) {
      if (s.img) { log("award card shown"); await shot("graduate-card"); break; }
      if (s.target === "make-card") { await ev(`document.getElementById("grad-name").value = "Dogfood"; true`); await click("make-card"); continue; }
      if (s.target === "share-x") {
        let ok = false;
        for (let w = 0; w < 20 && !ok; w++) { await sleep(500); ok = await ev(`(() => { const i = document.querySelector(".award-img"); return !!(i && i.complete && i.naturalWidth); })()`); }
        await ev(`document.querySelector(".award-img")?.scrollIntoView({ block: "center" }); true`); await sleep(300);
        if (ok) { log("award card image loaded"); await shot("graduate-card"); } else await flag("award", "card image did not load");
        break;
      }
    }
    // real-player shortcut: try Next past Level 1's steps without running them
    if (process.env.SKIPTEST && s.hash === "#/level/issue" && /^(Do it|Now break it)$/.test(s.title) && skipped < 2 && s.next && !s.next.disabled) {
      skipped++; log("SKIPTEST: pressing Next instead of", s.target); await click(s.next.pt); continue;
    }
    // With the fix: Next on an unrun step stays put, and Level 2 by URL shows "Locked".
    if (process.env.SKIPTEST && s.hash === "#/level/issue" && s.title === "Do it" && skipped < 2 && s.next?.disabled) {
      skipped = 9; await click(s.next.pt); await sleep(400); s = await read();
      await shot(`fix-next-blocked-${s.title}`); log("SKIPTEST: Next on unrun step ->", s.title, s.hint);
      if (s.title !== "Do it") await flag("skip", `Next moved past an unrun step to ${s.title}`);
      await ev(`location.hash = "#/level/freeze"; true`); await sleep(600); s = await read();
      await shot(`fix-level2-by-url-${s.title}`); log("SKIPTEST: #/level/freeze ->", s.title, s.target);
      if (s.title !== "Locked") await flag("skip", `Level 2 opened by URL: ${s.title}`);
      if (s.target) await click(s.target);
      continue;
    }
    if (process.env.SKIPTEST && skipped >= 2 && skipped < 9) {
      if (/Almost there/.test(s.title) && s.next && !s.next.disabled && /Level 2/.test(s.next.text)) { await flag("skip", `Level 1 not done but finish card offers ${s.next.text}`); skipped = 3; await click(s.next.pt); continue; }
      if (skipped === 3 && s.hash === "#/level/freeze") {
        await flag("skip", `Level 2 opened while Level 1 is unfinished: ${s.title}`);
        await ev(`(() => { const u = JSON.parse(localStorage.getItem("dch-ui-v2") || "{}"); u.step = { ...(u.step || {}), freeze: 3 }; localStorage.setItem("dch-ui-v2", JSON.stringify(u)); location.hash = "#/map"; setTimeout(() => location.hash = "#/level/freeze", 50); return true; })()`);
        await sleep(1200); s = await read();
        if (s.target === "run-fail" || (await ev(`!!document.querySelector('[data-pt="run-fail"]:not([disabled])')`))) { await click("run-fail"); for (let w = 0; w < 60; w++) { await sleep(1000); s = await read(); if (!s.busy) break; } }
        await flag("skip", `Level 2 should-fail result: ${s.bad || s.lead}`);
        skipped = 9; await ev(`location.hash = "#/map"; true`); continue;
      }
    }
    if (s.choices.length && s.choices.some((c) => !c.disabled)) {
      const lvl = s.hash.replace("#/level/", "");
      const qtext = await ev(`document.querySelector(".card .lead").textContent`);
      const qi = (QUIZZES[lvl] || []).findIndex((q) => q.q === qtext);
      if (qi < 0) { await flag("quiz", `unknown question on ${lvl}: ${qtext}`); break; }
      const q = QUIZZES[lvl][qi];
      const wrong = process.env.WRONG === lvl && !wrongDone && qi === 0;
      if (wrong) wrongDone = true;
      const k = wrong ? (q.answer + 1) % q.choices.length : q.answer;
      log(`quiz ${lvl} Q${qi + 1}: ${wrong ? "WRONG" : "right"} -> ${q.choices[k]}`);
      await click(`quiz-choice-${k}`);
      continue;
    }
    if (s.target) { await click(s.target); continue; }
    if (s.next && !s.next.disabled) { await click(s.next.pt); continue; }
    if (s.next && s.next.disabled) { await sleep(1500); if (JSON.stringify(await read()) !== JSON.stringify(s)) continue; await flag("deadend", `${s.hash} ${s.title}: no pointer target and Next disabled`); await sleep(2000); continue; }
    await flag("deadend", `${s.hash} ${s.title}: nothing to press`);
    break;
  }
} catch (e) { await flag("crash", e.message); }
finally {
  log(`done in ${Math.round((Date.now() - t0) / 1000)} s; steps ${steps}; findings ${findings.length}; page errors: ${errors.length ? JSON.stringify(errors.slice(0, 5)) : "none"}`);
  for (const f of findings) log(" -", f.kind, f.msg);
  ws.close(); chrome.kill();
  process.exitCode = findings.some((f) => f.kind !== "skip") ? 1 : 0;
}
