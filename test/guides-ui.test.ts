// Lesson guides in a real browser, offline: the local test server, with the video requests answered by the test.
// No ledger, no faucet, no network, no video files. Media events are fired by the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { Wallet } from "xrpl";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-guides-ui-"));
delete process.env.DCH_GUIDE_PICKER;
delete process.env.DCH_GUIDE_VIDEO_BASE;
const { Game } = await import("../src/game.ts");
const { loadConfig } = await import("../src/config.ts");
const { QUIZZES } = await import("../src/quizzes.ts");
const { createHandler } = await import("../src/server.ts");
const { chromium } = await import("playwright");

async function harness() {
  const g = new Game(loadConfig({ XRPL_NETWORK: "devnet" }), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 100, maxAwards: 100 });
  const any = g as any;
  any.ledger = async () => ({});
  any.fundAccounts = async () => Object.fromEntries(["issuer", "holder", "lender", "borrower", "auditor", "holderBot"].map((k) => {
    const w = Wallet.generate();
    return [k, { address: w.address, seed: w.seed }];
  }));
  any.shared.amendments = { network: "devnet", checkedAt: new Date(0).toISOString(), amendments: {} };
  any.levelAvailable = () => true;
  const server = createServer(createHandler(g));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** A world with a seat claimed by its wallet (Level 0 steps done); the wallet quiz is answered when asked for. */
  async function world(opts: { walletQuiz: boolean; steps?: string[] }) {
    const address = Wallet.generate().address;
    await g.startWorld(address);
    const st = any.st(Game.key(address));
    st.seats.issuer.wallet = address;
    st.seats.issuer.player = "you";
    if (opts.walletQuiz) for (const [i, q] of QUIZZES.wallet.entries()) await g.answerQuiz("wallet", i, q.answer, address);
    for (const id of opts.steps ?? []) st.scores[id] = { goal: true, shouldFail: true };
    return address;
  }
  return { server, base, world };
}

type Env = { browser: Browser; base: string; world: (o: { walletQuiz: boolean; steps?: string[] }) => Promise<string>; videoRequests: string[] };

/** Video requests: recorded, then left hanging (never answered), or answered with a status. */
async function open(env: Env, address: string | null, opts: { status?: number; ui?: Record<string, number> } = {}) {
  const context: BrowserContext = await env.browser.newContext({ viewport: { width: 375, height: 667 } });
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.route(/lesson-videos|cdn\.example\.test/, (route) => {
    env.videoRequests.push(route.request().url());
    if (opts.status) route.fulfill({ status: opts.status, contentType: "text/plain", body: "no" });
    // else: left open, so the page sees neither data nor an error
  });
  await page.addInitScript(([addr, ui]) => {
    if (addr) localStorage.setItem("dch-wallet-address", addr as string);
    if (ui && !localStorage.getItem("dch-ui-v2")) localStorage.setItem("dch-ui-v2", JSON.stringify({ step: ui, read: [] }));
  }, [address, opts.ui ?? null] as const);
  await page.goto(env.base + "/");
  return { page, context, errors };
}
const title = (page: Page) => page.locator("h2#cardtitle").innerText();
const stored = (page: Page, addr: string) => page.evaluate((a) => localStorage.getItem(`dch-guide-v1:${a}`), addr);
const videoSrc = (page: Page) => page.locator("video.lesson-video").getAttribute("src");
const fire = (page: Page, ev: string) => page.evaluate((e) => document.querySelector("video.lesson-video")!.dispatchEvent(new Event(e)), ev);
const nextBtn = (page: Page) => page.locator('[data-continue="lesson"]');

async function suite(flag: boolean, fn: (env: Env) => Promise<void>, videoBase?: string) {
  if (flag) process.env.DCH_GUIDE_PICKER = "1"; else delete process.env.DCH_GUIDE_PICKER;
  if (videoBase) process.env.DCH_GUIDE_VIDEO_BASE = videoBase; else delete process.env.DCH_GUIDE_VIDEO_BASE;
  const h = await harness();
  const browser = await chromium.launch();
  try { await fn({ browser, base: h.base, world: h.world, videoRequests: [] }); }
  finally { await browser.close(); h.server.close(); delete process.env.DCH_GUIDE_PICKER; delete process.env.DCH_GUIDE_VIDEO_BASE; }
}

test("picker: shows two picture cards at game start, remembers the pick for that world, asks again in another world", async () => {
  await suite(true, async (env) => {
    const x = await env.world({ walletQuiz: false });
    const y = await env.world({ walletQuiz: false });
    const a = await open(env, x);
    await a.page.locator(".guide-picker").waitFor();
    assert.equal(await title(a.page), "Pick your guide");
    assert.equal(await a.page.locator(".guide-card").count(), 2);
    assert.deepEqual(await a.page.locator(".guide-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-guide"))), ["a", "b"]);
    const imgs = await a.page.locator(".guide-card img").evaluateAll((els) => els.map((e) => ({ src: (e as HTMLImageElement).getAttribute("src"), w: (e as HTMLImageElement).naturalWidth, alt: (e as HTMLImageElement).alt })));
    assert.deepEqual(imgs.map((i) => i.src), ["/guides/guide-a.jpg", "/guides/guide-b.jpg"]);
    assert.ok(imgs.every((i) => i.w > 0 && i.alt.length > 10), "pictures load and have alt text");
    assert.equal(await a.page.locator(".circuit").count(), 0, "the map waits for the pick");
    await a.page.click('[data-guide="a"]');
    await a.page.locator(".circuit").waitFor();
    assert.deepEqual(JSON.parse((await stored(a.page, x))!), { guide: "a", seen: [] });
    await a.page.reload();
    await a.page.locator(".circuit").waitFor();
    assert.equal(await a.page.locator(".guide-picker").count(), 0, "kept after a reload");
    // another world (another wallet) is asked again, and its pick does not touch the first
    const b = await open(env, y);
    await b.page.locator(".guide-picker").waitFor();
    await b.page.click('[data-guide="b"]');
    await b.page.locator(".circuit").waitFor();
    assert.equal(JSON.parse((await stored(b.page, y))!).guide, "b");
    assert.equal(JSON.parse((await stored(a.page, x))!).guide, "a");
    assert.deepEqual([...a.errors, ...b.errors], []);
    await a.context.close(); await b.context.close();
  });
});

test("picker: a pick made before the wallet exists is kept when the wallet appears", async () => {
  await suite(true, async (env) => {
    const x = await env.world({ walletQuiz: false });
    const p = await open(env, null);
    await p.page.locator(".guide-picker").waitFor();
    await p.page.click('[data-guide="b"]');
    await p.page.locator(".circuit").waitFor();
    assert.equal(JSON.parse((await p.page.evaluate(() => localStorage.getItem("dch-guide-v1:pending")))!).guide, "b");
    await p.page.evaluate((a) => localStorage.setItem("dch-wallet-address", a), x);
    await p.page.reload();
    await p.page.locator(".circuit").waitFor();
    assert.equal(await p.page.locator(".guide-picker").count(), 0);
    assert.equal(JSON.parse((await stored(p.page, x))!).guide, "b");
    assert.equal(await p.page.evaluate(() => localStorage.getItem("dch-guide-v1:pending")), null);
    await p.context.close();
  });
});

test("Change guide: a button on the map opens the picker with the current guide marked; the new pick is kept", async () => {
  await suite(true, async (env) => {
    const x = await env.world({ walletQuiz: false });
    const a = await open(env, x);
    await a.page.click('[data-guide="a"]');
    await a.page.locator(".circuit").waitFor();
    await a.page.click('[data-pt="change-guide"]');
    await a.page.locator(".guide-picker").waitFor();
    assert.equal(await title(a.page), "Change your guide");
    assert.equal(await a.page.locator('[data-guide="a"]').getAttribute("aria-pressed"), "true");
    // keeping the guide goes back to the map unchanged
    await a.page.click('[data-pt="guide-keep"]');
    await a.page.locator(".circuit").waitFor();
    assert.equal(JSON.parse((await stored(a.page, x))!).guide, "a");
    await a.page.click('[data-pt="change-guide"]');
    await a.page.click('[data-guide="b"]');
    await a.page.locator(".circuit").waitFor();
    assert.equal(JSON.parse((await stored(a.page, x))!).guide, "b");
    await a.page.reload();
    await a.page.locator(".circuit").waitFor();
    assert.equal(await a.page.locator(".guide-picker").count(), 0);
    assert.equal(JSON.parse((await stored(a.page, x))!).guide, "b");
    assert.deepEqual(a.errors, []);
    await a.context.close();
  });
});

test("lesson video: the file follows the level and the guide, the wallet level uses the level 1 files", async () => {
  await suite(true, async (env) => {
    const w = await env.world({ walletQuiz: false });
    const i = await env.world({ walletQuiz: true, steps: ["issue"] });
    for (const [guide, wallet, issue] of [["a", "level1-guide-a.mp4", "issue-guide-a.mp4"], ["b", "level1-guide-b-v2.mp4", "issue-guide-b.mp4"]]) {
      const pw = await open(env, w, { ui: { wallet: 99 } });
      await pw.page.click(`[data-guide="${guide}"]`);
      await pw.page.goto(env.base + "/#/level/wallet");
      await pw.page.reload();
      await pw.page.locator("video.lesson-video").waitFor();
      assert.equal(await title(pw.page), "Lesson video");
      assert.equal(await videoSrc(pw.page), `/lesson-videos/${wallet}`, `wallet, guide ${guide}`);
      await pw.context.close();
      const pi = await open(env, i, { ui: { issue: 4 } });
      await pi.page.click(`[data-guide="${guide}"]`);
      await pi.page.goto(env.base + "/#/level/issue");
      await pi.page.reload();
      await pi.page.locator("video.lesson-video").waitFor();
      assert.equal(await videoSrc(pi.page), `/lesson-videos/${issue}`, `issue, guide ${guide}`);
      assert.deepEqual(pi.errors, []);
      await pi.context.close();
    }
    assert.ok(env.videoRequests.some((u) => u.endsWith("/lesson-videos/level1-guide-b-v2.mp4")));
  });
});

test("lesson video: the base URL comes from DCH_GUIDE_VIDEO_BASE", async () => {
  await suite(true, async (env) => {
    const x = await env.world({ walletQuiz: true, steps: ["issue"] });
    const p = await open(env, x, { ui: { issue: 4 } });
    await p.page.click('[data-guide="a"]');
    await p.page.goto(env.base + "/#/level/issue");
    await p.page.reload();
    await p.page.locator("video.lesson-video").waitFor();
    assert.equal(await videoSrc(p.page), "https://cdn.example.test/lessons/issue-guide-a.mp4");
    await p.context.close();
  }, "https://cdn.example.test/lessons");
});

async function atLesson(env: Env, guide: string, opts: { status?: number } = {}) {
  const x = await env.world({ walletQuiz: true, steps: ["issue"] });
  const p = await open(env, x, { ui: { issue: 4 }, ...opts });
  await p.page.click(`[data-guide="${guide}"]`);
  await p.page.goto(env.base + "/#/level/issue");
  await p.page.reload();
  await p.page.locator(".card").waitFor();
  return { ...p, x };
}

test("lesson video: Continue waits for the end or Skip; nothing advances by itself; Continue opens the quiz", async () => {
  await suite(true, async (env) => {
    const p = await atLesson(env, "a");
    await p.page.locator("video.lesson-video").waitFor();
    assert.equal(await title(p.page), "Lesson video");
    assert.equal(await nextBtn(p.page).getAttribute("aria-disabled"), "true", "Continue is not yet available");
    await p.page.evaluate(() => (document.querySelector('[data-continue="lesson"]') as HTMLElement).click());
    assert.equal(await title(p.page), "Lesson video", "pressing it early stays on the lesson");
    await p.page.evaluate(() => { (window as any).__hashes = []; addEventListener("hashchange", () => (window as any).__hashes.push(location.hash)); });
    const hash = await p.page.evaluate(() => location.hash);
    await fire(p.page, "ended");
    await p.page.waitForFunction(() => document.querySelector('[data-continue="lesson"]')?.getAttribute("aria-disabled") == null);
    await p.page.waitForTimeout(1500); // no timer may carry the player on
    assert.equal(await title(p.page), "Lesson video", "still on the lesson after the video ended");
    assert.equal(await p.page.evaluate(() => location.hash), hash);
    assert.deepEqual(await p.page.evaluate(() => (window as any).__hashes), [], "no route change");
    assert.equal(await p.page.locator(".card:has-text('Quiz 1 of')").count(), 0);
    await nextBtn(p.page).click();
    assert.equal(await title(p.page), "Quiz 1 of 3");
    // the quiz is still reachable going back and forth
    await p.page.click('[data-pt="back"]');
    assert.equal(await title(p.page), "Lesson video");
    assert.equal(await nextBtn(p.page).getAttribute("aria-disabled"), null, "watched: Continue stays open");
    assert.deepEqual(p.errors, []);
    await p.context.close();
  });
});

test("lesson video: Skip stops the video and opens Continue; Replay starts it again", async () => {
  await suite(true, async (env) => {
    const p = await atLesson(env, "b");
    await p.page.locator("video.lesson-video").waitFor();
    assert.equal(await p.page.locator('[data-pt="lesson-skip"]').count(), 1);
    await p.page.click('[data-pt="lesson-skip"]');
    assert.equal(await title(p.page), "Lesson video", "Skip does not move on either");
    assert.equal(await nextBtn(p.page).getAttribute("aria-disabled"), null, "Continue is open after Skip");
    assert.equal(await p.page.locator('[data-pt="lesson-skip"]').count(), 0);
    assert.equal(await p.page.evaluate(() => document.querySelector("video")!.paused), true, "Skip paused it");
    assert.deepEqual(JSON.parse((await stored(p.page, p.x))!).seen, ["issue:b"]);
    // Replay: from the start, playing, and the card stays put
    await p.page.evaluate(() => { document.querySelector("video")!.currentTime = 0.5; });
    await p.page.click('[data-pt="lesson-replay"]');
    await p.page.waitForFunction(() => document.querySelector("video.lesson-video") && !(document.querySelector("video.lesson-video") as HTMLVideoElement).paused);
    assert.equal(await title(p.page), "Lesson video");
    assert.equal(await p.page.evaluate(() => (document.querySelector("video") as HTMLVideoElement).currentTime), 0);
    assert.equal(await nextBtn(p.page).getAttribute("aria-disabled"), null, "already watched: Continue stays open");
    await nextBtn(p.page).click();
    assert.equal(await title(p.page), "Quiz 1 of 3");
    assert.deepEqual(p.errors, []);
    await p.context.close();
  });
});

test("lesson video: when the video cannot load, it says so and Continue still reaches the quiz", async () => {
  await suite(true, async (env) => {
    const p = await atLesson(env, "a", { status: 404 });
    await p.page.locator('[data-lesson-status="unavailable"]').waitFor();
    assert.equal(await p.page.locator('[data-lesson-status="unavailable"]').innerText(), "Video unavailable");
    assert.equal(await p.page.locator("video").count(), 0);
    assert.equal(await title(p.page), "Lesson video");
    assert.equal(await nextBtn(p.page).getAttribute("aria-disabled"), null, "Continue is open");
    await nextBtn(p.page).click();
    assert.equal(await title(p.page), "Quiz 1 of 3");
    assert.equal(await p.page.evaluate(() => JSON.parse(localStorage.getItem("dch-guide-v1:" + localStorage.getItem("dch-wallet-address"))!).seen.length), 0, "a failed video is not counted as watched");
    assert.deepEqual(p.errors, []);
    await p.context.close();
  });
});

test("lesson video: the wallet level's lesson comes right before its quiz, after the seat step", async () => {
  await suite(true, async (env) => {
    const w = await env.world({ walletQuiz: false });
    const p = await open(env, w, { ui: { wallet: 99 } });
    await p.page.click('[data-guide="a"]');
    await p.page.goto(env.base + "/#/level/wallet");
    await p.page.reload();
    await p.page.locator("video.lesson-video").waitFor();
    await p.page.click('[data-pt="back"]');
    assert.equal(await title(p.page), "Seat claimed ✓");
    await p.page.click('[data-pt^="next-"]');
    await p.page.click('[data-pt="lesson-skip"]');
    await nextBtn(p.page).click();
    assert.equal(await title(p.page), "Quiz 1 of 3");
    await p.context.close();
  });
});

test("flag off: no picker, no Change guide, no lesson video, no guide request, quiz comes straight after the steps", async () => {
  await suite(false, async (env) => {
    const x = await env.world({ walletQuiz: true, steps: ["issue"] });
    const reqs: string[] = [];
    const p = await open(env, x, { ui: { issue: 4 } });
    p.page.on("request", (r) => reqs.push(new URL(r.url()).pathname));
    await p.page.reload();
    await p.page.locator(".circuit").waitFor();
    assert.equal(await p.page.locator(".guide-picker, .guide-card, [data-pt='change-guide']").count(), 0);
    assert.equal(await p.page.locator('meta[name="dch-guides"]').count(), 0);
    await p.page.goto(env.base + "/#/level/issue");
    await p.page.reload();
    await p.page.locator(".card").waitFor();
    assert.equal(await title(p.page), "Quiz 1 of 3");
    assert.equal(await p.page.locator("video").count(), 0);
    assert.equal(await p.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("dch-guide"))).then((k) => k.length), 0, "nothing is stored");
    assert.deepEqual(reqs.filter((r) => /guides|lesson-videos/.test(r)), [], "no guide file is requested");
    assert.deepEqual(env.videoRequests, []);
    assert.deepEqual(p.errors, []);
    await p.context.close();
  });
});
