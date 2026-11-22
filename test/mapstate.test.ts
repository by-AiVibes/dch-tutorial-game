import { test } from "node:test";
import assert from "node:assert/strict";

const M: any = await import("../public/mapstate.js" as string);

type Lv = { id: string; n: number; title: string; goalRoles: string[]; available: boolean; score: { goal: boolean; shouldFail: boolean } };
const IDS = ["wallet", "issue", "freeze", "creds", "domain", "batch", "vault", "lend", "confidential"];
function levels(over: Record<string, Partial<Lv>> = {}): Lv[] {
  return IDS.map((id, n) => ({
    id, n, title: id, available: true,
    goalRoles: n === 0 || id === "confidential" ? [] : ["issuer"],
    score: { goal: false, shouldFail: false },
    ...over[id],
  }));
}
const both = { score: { goal: true, shouldFail: true } };
const statuses = (ms: any) => ms.nodes.map((x: any) => x.status);

test("map: fresh player — Level 0 is current, everything else locked, only the power trace lit", () => {
  const ms = M.mapState(levels(), {});
  assert.equal(ms.current, "wallet");
  assert.deepEqual(statuses(ms), ["current", ...Array(8).fill("locked")]);
  assert.deepEqual(ms.traces.map((t: any) => t.lit), [true, ...Array(9).fill(false)]);
  assert.equal(ms.doneCount, 0);
  assert.equal(ms.total, 9);
  assert.equal(ms.allComplete, false);
});

test("map: wallet done + Level 1 both parts closes two switches and lights to Level 2", () => {
  const ms = M.mapState(levels({ issue: both }), { walletDone: true });
  assert.deepEqual(statuses(ms).slice(0, 3), ["done", "done", "current"]);
  assert.deepEqual(ms.nodes.slice(0, 3).map((x: any) => x.closed), [true, true, false]);
  assert.deepEqual(ms.traces.slice(0, 4).map((t: any) => t.lit), [true, true, true, false]);
  assert.equal(ms.current, "freeze");
  assert.equal(ms.doneCount, 2);
});

test("map: a scored level with only one part is current + partial, switch still open", () => {
  const ms = M.mapState(levels({ issue: { score: { goal: true, shouldFail: false } } }), { walletDone: true });
  const n = ms.nodes[1];
  assert.equal(n.status, "current");
  assert.equal(n.partial, true);
  assert.equal(n.closed, false);
  assert.equal(ms.traces[2].lit, false, "power stops at the open switch");
});

test("map: power stops at the first open switch even if later levels are done", () => {
  const ms = M.mapState(levels({ issue: both, creds: both }), { walletDone: false });
  assert.deepEqual(statuses(ms).slice(0, 4), ["current", "done", "locked", "done"]);
  assert.deepEqual(ms.traces.slice(0, 5).map((t: any) => t.lit), [true, false, false, false, false]);
});

test("map: levels whose amendment is off are 'soon', bypassed, and don't block completion", () => {
  const all = Object.fromEntries(IDS.slice(1, 8).map((id) => [id, both]));
  const ms = M.mapState(levels({ ...all, vault: { available: false }, lend: { available: false } }), { walletDone: true, read: ["confidential"] });
  assert.equal(ms.nodes[6].status, "soon");
  assert.equal(ms.nodes[6].closed, false);
  assert.equal(ms.total, 7);
  assert.equal(ms.allComplete, true);
  assert.ok(ms.traces.every((t: any) => t.lit));
});

test("map: explainer closes only after it is read; all done lights the lamp", () => {
  const all = Object.fromEntries(IDS.slice(1, 8).map((id) => [id, both]));
  let ms = M.mapState(levels(all), { walletDone: true, read: [] });
  assert.equal(ms.current, "confidential");
  assert.equal(ms.traces.at(-1).lit, false);
  ms = M.mapState(levels(all), { walletDone: true, read: ["confidential"] });
  assert.equal(ms.allComplete, true);
  assert.equal(ms.current, null);
  assert.ok(ms.nodes.every((x: any) => x.closed));
  assert.equal(ms.traces.length, 10);
  assert.ok(ms.traces.every((t: any) => t.lit), "full circuit lit");
});

test("map: unsorted input is ordered by level number; layout and traces are well-formed", () => {
  const ms = M.mapState(levels().reverse(), {});
  assert.deepEqual(ms.nodes.map((x: any) => x.n), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const cols of [2, 3]) {
    const L = M.layout(9, cols);
    const pts = [-1, ...Array.from({ length: 10 }, (_, i) => i)].map((s) => L.pos(s));
    for (const p of pts) assert.ok(p.x > 0 && p.x < L.w && p.y > 0 && p.y < L.h, `cols ${cols}: ${JSON.stringify(p)} inside ${L.w}x${L.h}`);
    assert.match(M.tracePath(pts[1], pts[2]), /^M\d/);
  }
});

test("browser UI code never stores or sends a seed", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["app.js", "level0.js", "mapstate.js", "diagrams.js"]) {
    const src = readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
    assert.ok(!/localStorage\.setItem\([^)]*seed/i.test(src), `${f}: seed must not be stored`);
    for (const m of src.matchAll(/JSON\.stringify\(([^)]*)\)/g)) assert.ok(!/seed/i.test(m[1]), `${f}: request body ${m[1]}`);
    assert.ok(!/console\.\w+\([^)]*seed/i.test(src), `${f}: seed must not be logged`);
    assert.ok(!/https?:\/\/(?!xrpl\.org|\$\{|www\.w3\.org\/2000\/svg)/.test(src), `${f}: no external hosts besides the faucet`);
  }
});

test("ring map: switches sit on a circle around the core, inside the board, labels outside the ring", () => {
  const L = M.ringLayout(9);
  const d = (p: any) => Math.hypot(p.x - L.cx, p.y - L.cy);
  for (let i = 0; i < 9; i++) {
    const p = L.pos(i), lab = L.label(i);
    assert.ok(Math.abs(d(p) - L.r) < 1e-6, "on the ring");
    assert.ok(p.x > 30 && p.x < L.w - 30 && p.y > 30 && p.y < L.h - 30, "inside the board");
    assert.ok(d(lab) > L.r + 20, "label outside the ring");
    assert.ok(["start", "end", "middle"].includes(lab.anchor));
  }
  assert.ok(Math.abs(L.pos(0).x - L.cx) < 1e-6 && L.pos(0).y < L.cy, "Level 0 at the top");
  assert.ok(L.pos(2).x > L.cx, "clockwise");
  assert.match(M.ringArc(L, 0, 1), /^M[\d.]+ [\d.]+ A[\d.]+ [\d.]+ 0 0 1 [\d.]+ [\d.]+$/);
});

test("teaching diagrams: every scored level has goal + should-fail diagrams; captions stay short", async () => {
  const D: any = await import("../public/diagrams.js" as string);
  for (const id of ["issue", "freeze", "creds", "domain", "batch", "vault", "lend"]) {
    assert.ok(D.DIAG[`${id}:goal`], `${id}:goal`);
    const f = D.DIAG[`${id}:fail`];
    assert.ok(f && Number.isInteger(f.bad), `${id}:fail marks the refused link`);
  }
  for (const k of ["wallet:devnet", "wallet:wallet", "wallet:seed", "wallet:fund", "wallet:world", "wallet:seat", "seat", "done"]) assert.ok(D.DIAG[k], k);
  for (const [k, d] of Object.entries<any>(D.DIAG)) {
    assert.ok(d.caption.length >= 1 && d.caption.length <= 2, `${k}: 1-2 caption lines`);
    for (const line of d.caption) assert.ok(line.length <= 64, `${k}: caption too long: ${line}`);
    assert.ok(d.nodes.length >= 2 && d.nodes.length <= 3, `${k}: 2-3 nodes`);
    for (const nd of d.nodes) assert.ok(D.ICONS[nd.icon], `${k}: icon ${nd.icon}`);
    if (d.bad !== undefined) assert.ok(d.bad < d.nodes.length - 1, `${k}: bad link index`);
  }
});
