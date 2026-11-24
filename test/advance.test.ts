// After a level run finishes, the page stays on that run until Continue.
// Fake timers move well past the old celebration and stream-grace delays.
// Fetch is the local test server only: no ledger, no public network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page, Response } from "playwright";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Wallet } from "xrpl";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-advance-"));
const { Game } = await import("../src/game.ts");
const { loadConfig } = await import("../src/config.ts");
const { QUIZZES } = await import("../src/quizzes.ts");
const { chromium } = await import("playwright");

const RUN_EVENTS = [
  "Issuer sets DefaultRipple",
  "Holder opens a trust line",
  "Holder bot opens a trust line",
  "Issuer sends TST",
  "Holder pays through the issuer",
  "The path stays liquid",
  "Ledger accepts the payment",
  "Tokens arrive",
].map((label, i) => ({
  label,
  type: i === 0 ? "AccountSet" : i < 3 ? "TrustSet" : "Payment",
  engineResult: "tesSUCCESS",
  hash: "A".repeat(63) + i.toString(16),
  validated: true,
  ledgerIndex: 100 + i,
}));

const NEXT: Record<string, string> = { issue: "freeze", freeze: "creds" };

test("completion never assigns a route from a timer", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /setTimeout\(\s*\(\)\s*=>\s*go\(/);
  assert.doesNotMatch(app, /setTimeout\(\s*\(\)\s*=>\s*\{[^}]*\bgo\(/);
  assert.doesNotMatch(app, /location\.hash\s*=\s*["']#\//);
  assert.match(app, /res\.hold = part/);
  assert.match(app, /"data-continue": "run"/);
  assert.match(app, /Read the run, then press Continue/);
  assert.match(app, /navrow" \+ \(c\.hold \? " pinned"/);
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(raw);
}

async function startHarness() {
  const g = new Game(loadConfig({ XRPL_NETWORK: "devnet" }), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 100, maxAwards: 100 });
  const any = g as any;
  any.ledger = async () => ({});
  any.fundAccounts = async () => Object.fromEntries(["issuer", "holder", "lender", "borrower", "auditor", "holderBot"].map((k) => {
    const w = Wallet.generate();
    return [k, { address: w.address, seed: w.seed }];
  }));
  any.shared.amendments = { network: "devnet", checkedAt: new Date(0).toISOString(), amendments: {} };
  any.levelAvailable = () => true;

  async function world(doneLevels: string[]) {
    const address = Wallet.generate().address;
    await g.startWorld(address);
    const st = any.st(Game.key(address));
    st.seats.issuer.wallet = address;
    st.seats.issuer.player = "you";
    for (const [i, q] of QUIZZES.wallet.entries()) await g.answerQuiz("wallet", i, q.answer, address);
    for (const id of doneLevels) {
      st.scores[id] = { goal: true, shouldFail: true };
      for (const [i, q] of QUIZZES[id].entries()) await g.answerQuiz(id, i, q.answer, address);
    }
    return address;
  }

  const roots = new URL("../public/", import.meta.url);
  const jobs = new Map<string, { level: string; part: "goal" | "shouldFail"; world: string }>();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const p = url.pathname;
      if (p === "/vendor/xrpl.js") return send(res, 200, "window.xrpl = window.xrpl || {};\n", "text/javascript; charset=utf-8");
      if (p === "/api/state") {
        const worldKey = url.searchParams.get("world");
        return send(res, 200, g.view(Game.key(worldKey)));
      }
      const run = /^\/api\/levels\/([a-z]+)\/(goal|should-fail)$/.exec(p);
      if (req.method === "POST" && run) {
        const body = JSON.parse(await readBody(req) || "{}");
        const job = `job${run[1]}${run[2] === "goal" ? "goal" : "fail"}`;
        jobs.set(job, { level: run[1], part: run[2] === "goal" ? "goal" : "shouldFail", world: String(body.world || "") });
        return send(res, 202, { job, status: "running" });
      }
      const poll = /^\/api\/jobs\/([^/]+)$/.exec(p);
      if (req.method === "GET" && poll) {
        const id = decodeURIComponent(poll[1]);
        const meta = jobs.get(id);
        if (meta?.world) {
          const st = any.st(Game.key(meta.world));
          st.scores[meta.level] = { goal: false, shouldFail: false, ...(st.scores[meta.level] || {}), [meta.part]: true };
        }
        return send(res, 200, {
          job: id, status: "done", events: RUN_EVENTS,
          result: { ok: true, message: "Goal cleared.", added: 10, results: RUN_EVENTS.slice(0, 4).map((e) => ({ type: e.type, engineResult: e.engineResult, hash: e.hash })) },
        });
      }
      if (p.startsWith("/api/")) return send(res, 404, { error: "not in this test" });
      const name = p === "/" ? "index.html" : p.replace(/^\//, "");
      if (name.includes("..")) return send(res, 404, "no");
      const file = new URL(name, roots);
      const bytes = readFileSync(file);
      const type = extname(name) === ".css" ? "text/css; charset=utf-8" : extname(name) === ".html" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(bytes);
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { g, world, server, base };
}

async function openLevel(browser: Browser, base: string, address: string, id: string, step: number, reduce: boolean) {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, reducedMotion: reduce ? "reduce" : "no-preference" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript((events: { label: string }[]) => {
    const timers = new Map<number, { at: number; fn: () => void; every: number }>();
    let seq = 1;
    let now = 0;
    const epoch = Date.now();
    Date.now = () => epoch + now;
    performance.now = () => now;
    const arm = (fn: TimerHandler, ms: number, every: number) => {
      const id = seq++;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn: () => { if (typeof fn === "function") fn(); }, every });
      return id;
    };
    window.setTimeout = ((fn: TimerHandler, ms?: number) => arm(fn, ms || 0, 0)) as typeof setTimeout;
    window.setInterval = ((fn: TimerHandler, ms?: number) => arm(fn, ms || 0, Math.max(0, Number(ms) || 0))) as typeof setInterval;
    const clear = (id?: number) => { if (id) timers.delete(id); };
    window.clearTimeout = clear as typeof clearTimeout;
    window.clearInterval = clear as typeof clearInterval;
    const w = window as unknown as { __timerErrors: string[]; __advance: (ms: number) => void; __hashchanges: string[]; __runEvents: unknown[] };
    w.__timerErrors = [];
    w.__advance = (ms: number) => {
      const dest = now + ms;
      let guard = 0;
      for (;;) {
        let pick: { id: number; rec: { at: number; fn: () => void; every: number } } | null = null;
        for (const [id, rec] of timers) if (rec.at <= dest && (!pick || rec.at < pick.rec.at)) pick = { id, rec };
        if (!pick) break;
        if (++guard > 20000) { w.__timerErrors.push("timer loop"); break; }
        now = pick.rec.at;
        if (pick.rec.every) pick.rec.at = now + pick.rec.every;
        else timers.delete(pick.id);
        try { pick.rec.fn(); } catch (e) { w.__timerErrors.push(String(e)); }
      }
      now = dest;
    };
    w.__hashchanges = [];
    window.addEventListener("hashchange", () => w.__hashchanges.push(location.hash));
    w.__runEvents = events;
    class FakeEventSource {
      url = "";
      listeners: Record<string, Array<(ev: { data: string }) => void>> = {};
      closed = false;
      constructor(url: string) {
        this.url = url;
        queueMicrotask(() => {
          if (this.closed) return;
          for (const ev of w.__runEvents || []) this.emit("run", ev);
          this.emit("ledger", { ledgerIndex: 120, closeTime: "2026-11-24T12:00:00Z" });
        });
      }
      addEventListener(type: string, fn: (ev: { data: string }) => void) { (this.listeners[type] ||= []).push(fn); }
      close() { this.closed = true; }
      emit(type: string, data: unknown) {
        const frame = { data: JSON.stringify(data) };
        for (const fn of this.listeners[type] || []) fn(frame);
      }
    }
    window.EventSource = FakeEventSource as unknown as typeof EventSource;
  }, RUN_EVENTS);
  await page.addInitScript(({ address: addr, id, step: at }: { address: string; id: string; step: number }) => {
    localStorage.setItem("dch-wallet-address", addr);
    localStorage.setItem("dch-ui-v2", JSON.stringify({ step: { [id]: at }, read: [] }));
  }, { address, id, step });
  await page.goto(`${base}/#/level/${id}`, { waitUntil: "domcontentloaded" });
  return { context, page, errors };
}

async function snap(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __hashchanges: string[]; __timerErrors: string[] };
    const button = document.querySelector("[data-continue='run']");
    const box = button ? button.getBoundingClientRect() : null;
    return {
      hash: location.hash,
      title: document.querySelector("#cardtitle")?.textContent || "",
      log: document.querySelector("[data-run-log]")?.textContent || "",
      result: document.querySelector(".result.ok")?.textContent || "",
      changes: w.__hashchanges.slice(),
      errors: w.__timerErrors.slice(),
      cont: document.querySelector("[data-continue]")?.getAttribute("data-continue") || "",
      box: box ? { top: box.top, bottom: box.bottom, height: box.height, width: box.width, vh: innerHeight } : null,
      reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
}

async function screenText(page: Page) {
  return page.locator("#screen").innerText().catch(() => "");
}

test("a finished run keeps its log until Continue, then that click moves on", async (t) => {
  const harness = await startHarness();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); harness.server.close(); });

  for (const id of ["issue", "freeze"]) {
    for (const reduce of [false, true]) {
      // A finished goal sticks on the world, so each case needs its own world.
      const address = id === "freeze" ? await harness.world(["issue"]) : await harness.world([]);
      const { context, page, errors } = await openLevel(browser, harness.base, address, id, 2, reduce);
      try {
        await page.waitForSelector("[data-pt='run-goal']", { timeout: 8000 });
        const posted = page.waitForResponse((r: Response) => r.url().includes(`/api/levels/${id}/goal`) && r.request().method() === "POST");
        await page.click("[data-pt='run-goal']");
        await posted;
        const polled = page.waitForResponse((r: Response) => /\/api\/jobs\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === "GET");
        await page.evaluate(() => (window as unknown as { __advance: (ms: number) => void }).__advance(5_000));
        const poll = await polled;
        assert.equal((await poll.json() as { status: string }).status, "done");
        await page.waitForSelector("[data-continue='run']", { timeout: 8000 });
        const before = await snap(page);
        assert.equal(before.hash, `#/level/${id}`, `${id} reduce=${reduce} left the level when the job finished`);
        assert.equal(before.title, "Goal done ✓");
        assert.equal(before.cont, "run");
        assert.match(before.log, /Issuer sets DefaultRipple/);
        assert.match(before.log, /Tokens arrive/);
        assert.match(before.result, /Goal cleared/);
        assert.equal(before.reduce, reduce);
        assert.ok(before.box && before.box.top >= 0 && before.box.bottom <= before.box.vh + 1 && before.box.height >= 48 && before.box.width >= 120, `Continue off screen ${JSON.stringify(before.box)}`);
        // Past the 1.7s switch animation, the 4s stream grace, and the 3s poll.
        await page.evaluate(() => (window as unknown as { __advance: (ms: number) => void }).__advance(30_000));
        const held = await snap(page);
        assert.equal(held.hash, before.hash, "timers changed the route");
        assert.deepEqual(held.changes, before.changes);
        assert.equal(held.title, before.title);
        assert.match(held.log, /Issuer sets DefaultRipple/);
        assert.deepEqual(held.errors, []);
        await page.click("[data-continue='run']");
        await page.waitForFunction(() => document.querySelector("#cardtitle")?.textContent === "Now break it");
        const moved = await snap(page);
        assert.equal(moved.hash, `#/level/${id}`, "Continue stays inside the level for the next step");
        assert.equal(moved.title, "Now break it");
        assert.deepEqual(moved.changes, before.changes, "the next step is not a hash change");
        assert.equal(errors.length, 0, errors.join("\n"));
      } catch (e) {
        throw new Error(`${id} reduce=${reduce}: ${(e as Error).message}\n${(await screenText(page)).slice(0, 600)}`);
      } finally { await context.close(); }
    }
  }
});

test("level end stays put until Continue, and the switch animation does not change the route", async (t) => {
  const harness = await startHarness();
  const issue = await harness.world([]);
  const freeze = await harness.world(["issue"]);
  // Mark the level under test finished so its closing card is the one on screen.
  for (const [addr, id] of [[issue, "issue"], [freeze, "freeze"]] as const) {
    const st = (harness.g as any).st(Game.key(addr));
    st.scores[id] = { goal: true, shouldFail: true };
    for (const [i, q] of QUIZZES[id].entries()) await harness.g.answerQuiz(id, i, q.answer, addr);
  }
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); harness.server.close(); });
  const addressOf: Record<string, string> = { issue, freeze };

  for (const id of ["issue", "freeze"]) {
    for (const reduce of [false, true]) {
      const { context, page, errors } = await openLevel(browser, harness.base, addressOf[id], id, 99, reduce);
      try {
        await page.waitForSelector("[data-continue='level']", { timeout: 8000 });
        await page.evaluate(() => (window as unknown as { __advance: (ms: number) => void }).__advance(30_000));
        const before = await snap(page);
        assert.equal(before.hash, `#/level/${id}`);
        assert.equal(before.title, "Switch closed ✓");
        assert.deepEqual(before.changes, []);
        assert.equal(before.reduce, reduce);
        await page.click("[data-continue='level']");
        // The hash updates in the click; the map (and its flag) paint on hashchange.
        await page.waitForFunction((levelId: string) => location.hash === "#/map" && document.body.dataset.celebrate === levelId, id);
        await page.evaluate(() => (window as unknown as { __advance: (ms: number) => void }).__advance(30_000));
        const anim = await page.evaluate(() => ({
          hash: location.hash,
          celebrate: document.body.dataset.celebrate || "",
          animDone: document.body.dataset.animDone || "",
          changes: (window as unknown as { __hashchanges: string[] }).__hashchanges.slice(),
        }));
        assert.equal(anim.hash, "#/map", "the animation must not leave the map on its own");
        assert.equal(anim.celebrate, id);
        assert.equal(anim.animDone, "1");
        assert.deepEqual(anim.changes, ["#/map"]);
        await page.click("[data-pt='continue-next']");
        await page.waitForFunction((next: string) => location.hash === `#/level/${next}`, NEXT[id]);
        const moved = await snap(page);
        assert.equal(moved.hash, `#/level/${NEXT[id]}`);
        assert.equal(errors.length, 0, errors.join("\n"));
      } catch (e) {
        throw new Error(`${id} reduce=${reduce}: ${(e as Error).message}\n${(await screenText(page)).slice(0, 600)}`);
      } finally { await context.close(); }
    }
  }
});
