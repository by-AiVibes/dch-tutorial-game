// Headless check (Chrome via DevTools protocol; no extra deps): at 375px, every step card's title
// is visible after landing on a level and after each Next, even when the player had scrolled
// down first. Usage: BASE=http://localhost:8790 ADDR=<classic address> VH=500 node scripts/check-card-scroll.mjs
// (VH defaults to 667; use a short height like 500 to mimic a phone browser with its toolbars.)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const BASE = process.env.BASE || "http://localhost:8790";
const profile = process.env.PROFILE || `scrollcheck-${process.pid}`;
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/chr-profile-${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.find((t) => t.type === "page")) break; } catch {} await sleep(250); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map(); const errors = [];
ws.addEventListener("message", (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } else if (j.method === "Runtime.exceptionThrown") errors.push(j.params.exceptionDetails.exception?.description); else if (j.method === "Log.entryAdded" && j.params.entry.level === "error") errors.push(j.params.entry.text); });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
const click = (pt) => ev(`(() => { const e = document.querySelector('[data-pt="${pt}"]'); if (!e) throw new Error("missing ${pt}"); e.click(); return true; })()`);
const waitFor = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch {} await sleep(500); } throw new Error("timeout: " + expr); };
await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
let bad = 0, checks = 0;
try {
  const SHOTS = process.env.SHOTS || "";
  const [W, H] = [375, Number(process.env.VH || 667)];
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: BASE + "/" }); await sleep(800);
  await ev(`localStorage.clear(); localStorage.setItem("dch-wallet-address", ${JSON.stringify(process.env.ADDR || "")}); localStorage.setItem("dch-grad-seen", "1"); true`);
  const check = async (label) => {
    await sleep(900);
    const r = await ev(`(() => { const t = document.getElementById("cardtitle"); if (!t) return null; const b = t.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), y: Math.round(scrollY), title: t.textContent, vh: innerHeight }; })()`);
    checks++;
    const ok = r && r.top >= 50 && r.bottom <= r.vh; // below the sticky header, inside the viewport
    if (!ok) bad++;
    console.log(ok ? "ok  " : "BAD ", label, JSON.stringify(r));
  };
  for (const lvl of ["wallet", "issue", "freeze", "lend", "confidential"]) {
    await send("Page.navigate", { url: `${BASE}/#/map` }); await sleep(300);
    await ev(`localStorage.setItem("dch-ui-v2", JSON.stringify({ step: {}, read: [] })); true`);
    await send("Page.navigate", { url: `${BASE}/#/level/${lvl}` }); await sleep(200); await send("Page.reload");
    await waitFor(`!!document.getElementById("cardtitle")`);
    await check(`${lvl} card 0`);
    for (let i = 0; i < 8; i++) {
      const has = await ev(`!!document.querySelector('[data-pt="next-${i}"]') && document.querySelector('[data-pt="next-${i}"]').textContent.includes("Next")`);
      if (!has) break;
      await ev(`window.scrollTo(0, document.documentElement.scrollHeight); true`); // the player had scrolled down before pressing Next
      await sleep(150);
      await click(`next-${i}`);
      await check(`${lvl} after Next -> card ${i + 1}`);
      if (SHOTS && lvl === "wallet" && i === 1) { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(SHOTS + "scrollfix-level0-card2-375.png", Buffer.from(r.result.data, "base64")); }
    }
  }
  console.log(`checks ${checks}, bad ${bad}; page errors:`, errors.length ? errors : "none");
} catch (e) { console.log("FAIL", e.message, errors); }
finally { ws.close(); chrome.kill(); if (bad || !checks) process.exitCode = 1; }
