// Lesson guides, offline: the flag, the server's page, the manifest and the per-world choice.
// Pure functions and the local test server only. No browser, no network, no videos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-guides-"));
delete process.env.DCH_GUIDE_PICKER;
delete process.env.DCH_GUIDE_VIDEO_BASE;
const { Game } = await import("../src/game.ts");
const { loadConfig } = await import("../src/config.ts");
const { createHandler } = await import("../src/server.ts");
const { LEVELS } = await import("../src/levels/index.ts");
const { guideConfig, cleanVideoBase, injectGuideConfig, DEFAULT_VIDEO_BASE } = await import("../src/guides.ts");
const G: any = await import("../public/guides.js" as string);

class FakeStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}
const ADDR_X = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ADDR_Y = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

// ---- the flag and the server ----

test("flag: off unless DCH_GUIDE_PICKER is exactly 1", () => {
  for (const v of [undefined, "", "0", "true", "yes", "on", "2", " 1"]) assert.equal(guideConfig({ DCH_GUIDE_PICKER: v } as NodeJS.ProcessEnv), null, String(v));
  assert.deepEqual(guideConfig({ DCH_GUIDE_PICKER: "1" } as NodeJS.ProcessEnv), { videoBase: DEFAULT_VIDEO_BASE });
  assert.equal(guideConfig({} as NodeJS.ProcessEnv), null);
});

test("video base: a same-origin path or an https URL, always with a trailing slash; anything else is the default", () => {
  assert.equal(cleanVideoBase(undefined), "/lesson-videos/");
  assert.equal(cleanVideoBase("/media/lessons"), "/media/lessons/");
  assert.equal(cleanVideoBase("https://cdn.example.test/lessons"), "https://cdn.example.test/lessons/");
  assert.equal(cleanVideoBase("https://cdn.example.test"), "https://cdn.example.test/");
  for (const bad of ["http://cdn.example.test/x/", "//evil.example/x/", "javascript:alert(1)", "/a/../b", "https://a b.test/", "data:video/mp4;base64,AAAA", 'https://x.test/"onload=1']) {
    assert.equal(cleanVideoBase(bad), DEFAULT_VIDEO_BASE, bad);
  }
});

test("page meta: config is attribute-escaped and added to the head only", () => {
  const html = injectGuideConfig("<html><head><title>t</title></head><body></body></html>", { videoBase: "/lesson-videos/" });
  assert.match(html, /<meta name="dch-guides" content="\{&quot;videoBase&quot;:&quot;\/lesson-videos\/&quot;\}">\n<\/head>/);
  assert.equal(injectGuideConfig("no head here", { videoBase: "/x/" }), "no head here");
});

async function serve() {
  const g = new Game(loadConfig({ XRPL_NETWORK: "devnet" }), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 100, maxAwards: 100 });
  const server = createServer(createHandler(g));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("server, flag off: index.html is byte-identical to the file and the guide pictures are not served", async () => {
  delete process.env.DCH_GUIDE_PICKER;
  const { server, base } = await serve();
  try {
    const file = readFileSync(new URL("../public/index.html", import.meta.url));
    for (const path of ["/", "/index.html"]) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(file), `${path} must be the file as it is`);
    }
    for (const img of ["/guides/guide-a.jpg", "/guides/guide-b.jpg"]) {
      const r = await fetch(base + img);
      assert.equal(r.status, 404, img);
      assert.deepEqual(await r.json(), { error: "not_found" });
    }
  } finally { server.close(); }
});

test("server, flag on: the page carries the config, the pictures are served as jpeg", async () => {
  process.env.DCH_GUIDE_PICKER = "1";
  process.env.DCH_GUIDE_VIDEO_BASE = "https://cdn.example.test/lessons";
  const { server, base } = await serve();
  try {
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /<meta name="dch-guides" content="[^"]*cdn\.example\.test\/lessons\/[^"]*">/);
    assert.equal(html.replace(/<meta name="dch-guides"[^>]*>\n/, ""), readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), "only the meta is added");
    for (const img of ["/guides/guide-a.jpg", "/guides/guide-b.jpg"]) {
      const r = await fetch(base + img);
      assert.equal(r.status, 200, img);
      assert.equal(r.headers.get("content-type"), "image/jpeg");
      assert.ok((await r.arrayBuffer()).byteLength < 200 * 1024, "web-sized");
    }
  } finally { server.close(); delete process.env.DCH_GUIDE_PICKER; delete process.env.DCH_GUIDE_VIDEO_BASE; }
});

test("pictures are web-sized jpegs in the repo; no video is committed", () => {
  for (const f of ["guide-a.jpg", "guide-b.jpg"]) {
    const p = new URL(`../public/guides/${f}`, import.meta.url);
    assert.ok(statSync(p).size <= 200 * 1024, `${f} must be at most 200 KB`);
    assert.deepEqual([...readFileSync(p).subarray(0, 3)], [0xff, 0xd8, 0xff]);
  }
});

// ---- the manifest ----

test("manifest: every game level has a lesson for each guide, and nothing else is listed", () => {
  const ids = LEVELS.map((l: { id: string }) => l.id);
  assert.deepEqual(Object.keys(G.LESSON_VIDEOS).sort(), [...ids].sort());
  assert.deepEqual(ids, ["wallet", "issue", "freeze", "creds", "domain", "batch", "vault", "lend", "confidential"]);
  for (const id of ids) assert.deepEqual(Object.keys(G.LESSON_VIDEOS[id]).sort(), ["a", "b"], id);
});

test("manifest: file names per level and guide, wallet level uses the level 1 files (guide B is v2)", () => {
  const want: Record<string, [string, string]> = {
    wallet: ["level1-guide-a.mp4", "level1-guide-b-v2.mp4"],
    issue: ["issue-guide-a.mp4", "issue-guide-b.mp4"],
    freeze: ["freeze-guide-a.mp4", "freeze-guide-b.mp4"],
    creds: ["creds-guide-a.mp4", "creds-guide-b.mp4"],
    domain: ["domain-guide-a.mp4", "domain-guide-b.mp4"],
    batch: ["batch-guide-a.mp4", "batch-guide-b.mp4"],
    vault: ["vault-guide-a.mp4", "vault-guide-b.mp4"],
    lend: ["lend-guide-a.mp4", "lend-guide-b.mp4"],
    confidential: ["confidential-guide-a.mp4", "confidential-guide-b.mp4"],
  };
  for (const [level, [a, b]] of Object.entries(want)) {
    assert.equal(G.lessonFile(level, "a"), a, `${level} a`);
    assert.equal(G.lessonFile(level, "b"), b, `${level} b`);
    assert.equal(G.videoUrl("/lesson-videos/", level, "a"), `/lesson-videos/${a}`);
    assert.equal(G.videoUrl("https://cdn.example.test/l", level, "b"), `https://cdn.example.test/l/${b}`);
  }
  assert.equal(G.lessonFile("nope", "a"), null);
  assert.equal(G.lessonFile("issue", "c"), null);
  assert.equal(G.lessonFile("toString", "a"), null);
  assert.equal(G.videoUrl("/x/", "nope", "a"), null);
});

test("config: read from the page meta; absent or broken means off", () => {
  const doc = (content?: string) => ({ querySelector: () => (content === undefined ? null : { getAttribute: () => content }) });
  assert.deepEqual(G.readGuideConfig(doc('{"videoBase":"/v/"}')), { videoBase: "/v/" });
  assert.equal(G.readGuideConfig(doc()), null);
  assert.equal(G.readGuideConfig(doc("not json")), null);
  assert.equal(G.readGuideConfig(doc('{"videoBase":5}')), null);
});

// ---- the choice, per world ----

test("choice: nothing until picked; kept per world; another world asks again", () => {
  const s = new FakeStorage();
  assert.equal(G.loadGuide(s, ADDR_X), null);
  G.saveGuide(s, ADDR_X, "a");
  assert.equal(G.loadGuide(s, ADDR_X).guide, "a");
  assert.equal(G.loadGuide(s, ADDR_Y), null, "a different world has not picked");
  G.saveGuide(s, ADDR_Y, "b");
  assert.equal(G.loadGuide(s, ADDR_X).guide, "a");
  assert.equal(G.loadGuide(s, ADDR_Y).guide, "b");
  assert.deepEqual(JSON.parse(s.getItem(`dch-guide-v1:${ADDR_X}`)!), { guide: "a", seen: [] });
});

test("choice: Change guide replaces it for that world only and keeps what was watched", () => {
  const s = new FakeStorage();
  G.saveGuide(s, ADDR_X, "a");
  G.markSeen(s, ADDR_X, "issue");
  G.saveGuide(s, ADDR_Y, "a");
  G.saveGuide(s, ADDR_X, "b");
  assert.equal(G.loadGuide(s, ADDR_X).guide, "b");
  assert.equal(G.loadGuide(s, ADDR_Y).guide, "a");
  assert.equal(G.hasSeen(G.loadGuide(s, ADDR_X), "issue"), false, "guide A's lesson does not count for guide B");
  G.saveGuide(s, ADDR_X, "a");
  assert.equal(G.hasSeen(G.loadGuide(s, ADDR_X), "issue"), true, "and is remembered when A comes back");
  assert.throws(() => G.saveGuide(s, ADDR_X, "c"));
});

test("choice: a pick made before the wallet exists moves to the first world that asks", () => {
  const s = new FakeStorage();
  assert.equal(G.loadGuide(s, ""), null);
  G.saveGuide(s, "", "b");
  assert.equal(s.getItem("dch-guide-v1:pending") !== null, true);
  assert.equal(G.loadGuide(s, "").guide, "b");
  assert.equal(G.loadGuide(s, ADDR_X).guide, "b");
  assert.equal(s.getItem("dch-guide-v1:pending"), null);
  assert.equal(G.loadGuide(s, ADDR_Y), null, "the pick is not shared with the next world");
});

test("choice: junk in storage reads as not picked; a broken storage still works for the page visit", () => {
  const s = new FakeStorage();
  s.setItem(`dch-guide-v1:${ADDR_X}`, "{not json");
  assert.equal(G.loadGuide(s, ADDR_X), null);
  s.setItem(`dch-guide-v1:${ADDR_X}`, JSON.stringify({ guide: "zzz" }));
  assert.equal(G.loadGuide(s, ADDR_X), null);
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  G.saveGuide(broken, ADDR_Y, "b");
  assert.equal(G.loadGuide(broken, ADDR_Y).guide, "b");
});

test("seen: only levels with a lesson are recorded; a level is recorded once", () => {
  const s = new FakeStorage();
  G.saveGuide(s, ADDR_X, "a");
  G.markSeen(s, ADDR_X, "issue");
  G.markSeen(s, ADDR_X, "issue");
  G.markSeen(s, ADDR_X, "nope");
  assert.deepEqual(G.loadGuide(s, ADDR_X).seen, ["issue:a"]);
  assert.equal(G.hasSeen(G.loadGuide(s, ADDR_X), "freeze"), false);
});

test("picture cards: two guides, each with a picture file that exists", () => {
  assert.deepEqual(G.GUIDES.map((g: { id: string }) => g.id), ["a", "b"]);
  for (const g of G.GUIDES) {
    assert.match(g.img, /^\/guides\/guide-[ab]\.jpg$/);
    assert.ok(statSync(new URL(`../public${g.img}`, import.meta.url)).size > 1000);
    assert.ok(g.alt.length > 10);
  }
});

test("public copy never names the hosting products", () => {
  for (const f of ["../public/guides.js", "../public/app.js", "../src/guides.ts", "../docs/lesson-videos.md"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /evrPanel|EverCloud|evernode\.app/i, f);
  }
});
