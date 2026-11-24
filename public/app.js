// Game UI: a circuit-board level map (home) plus short step cards per level, with a
// guided pointer at the next thing to click. Uses textContent everywhere (no innerHTML with data).
// Only UI position is kept in localStorage (never a seed); game progress comes from the server,
// from the player's OWN world, keyed by their wallet address (?world=<address>).
import { mapState, ringLayout, ringArc, levelKind, levelTodo, canOpen, clampStep, quizPending, celebrateFrame, CELEBRATE_SWITCH_MS, CELEBRATE_TOTAL_MS } from "./mapstate.js";
import { diagram } from "./diagrams.js";
import * as W from "./level0.js";

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  setAttrs(e, attrs);
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  setAttrs(e, attrs);
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
function setAttrs(e, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "class") e.setAttribute("class", v);
    else e.setAttribute(k, v === true ? "" : v);
  }
}
const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener" }, text);

// ---- UI state (localStorage: step positions, explainers read, Level 0 done; never seeds) ----
const UI_KEY = "dch-ui-v2";
const ui = (() => {
  try { const j = JSON.parse(localStorage.getItem(UI_KEY) || "{}"); return { step: j.step || {}, read: j.read || [] }; }
  catch { return { step: {}, read: [] }; }
})();
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify({ step: ui.step, read: ui.read }));
/** Seat label inside your own world. */
const me = () => (localStorage.getItem("dch-player") || "").trim() || "you";
const addr = () => W.currentAddress();
const wq = () => (addr() ? `?world=${encodeURIComponent(addr())}` : "");
/** Level 0 is done once your world exists and a seat in it is linked to your wallet. */
const walletDone = () => !!state?.world && !!addr() && Object.values(state.seats).some((x) => x.wallet === addr());

let state = null;
let busy = null; // label while a ledger action runs
const results = {}; // levelId -> { goal, shouldFail } last results this session
const l0 = { msg: "", bal: null, seedShown: false };

const API_TIMEOUT_MS = 90_000;
async function api(path, body) {
  // A request that never answers would leave the page busy forever: give up after 90 s
  // (starting a world takes ~30 s; long level runs are background jobs, polled in short calls).
  // AbortController + setTimeout, not the AbortSignal timeout() helper (missing on Safari/iOS < 16).
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false, timer;
  // Rejects after the limit even where fetch can't be aborted; aborts it where it can.
  const late = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; ctl?.abort(); reject(new SlowError()); }, API_TIMEOUT_MS); });
  try {
    const opts = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    if (ctl) opts.signal = ctl.signal;
    const r = await Promise.race([fetch(path, opts).catch(() => { throw timedOut ? new SlowError() : new NetError(); }), late]);
    const j = await Promise.race([r.json().catch(() => ({})), late]);
    if (r.status === 429 || r.status === 503) throw new Error(`The server is busy. Try again in ${r.headers.get("retry-after") || "a few"} seconds.`);
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  } finally { clearTimeout(timer); }
}
/** fetch itself failed (Safari says "Load failed"): the phone lost the connection, not the server. */
class NetError extends Error { constructor(msg = "The connection dropped.") { super(msg); } }
/** No answer within API_TIMEOUT_MS: the connection may be fine; the ledger work is slow. */
class SlowError extends NetError { constructor() { super("The ledger is slow. Reload to see where you are."); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The live log only reads these fields, even if a frame carried something else.
const RUN_FIELDS = ["label", "type", "engineResult", "hash", "validated", "ledgerIndex"];
const TX_HASH = /^[A-Fa-f0-9]{64}$/;
// Same shapes src/secrets.ts looksSecret refuses, so a label that embeds a seed never reaches the log.
function looksSecret(value) {
  const b58 = "1-9A-HJ-NP-Za-km-z";
  return [
    new RegExp("(^|[^" + b58 + "])s[" + b58 + "]{24,34}(?![" + b58 + "])"),
    /[0-9A-Fa-f]{32,}/,
    /\b[a-z]+(?:[\s,]+[a-z]+){11,}\b/,
    /\b\d{6}(?:[\s-]+\d{6}){7}\b/,
  ].some((re) => re.test(value));
}
function takeRun(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const k of RUN_FIELDS) if (raw[k] !== undefined) out[k] = raw[k];
  if (typeof out.hash === "string" && !TX_HASH.test(out.hash)) delete out.hash;
  if (typeof out.label === "string") {
    if (looksSecret(out.label)) delete out.label;
    else out.label = out.label.slice(0, 160);
  }
  return out.label || out.hash ? out : null;
}
function takeLedger(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.ledgerIndex !== "number" || !Number.isInteger(raw.ledgerIndex)) return null;
  if (typeof raw.closeTime !== "string" || raw.closeTime.length > 40) return null;
  return { ledgerIndex: raw.ledgerIndex, closeTime: raw.closeTime };
}
/** The tx's own ledger, once a relayed close has reached it. Missing index: say nothing. */
function ledgerMark(tx, latest) {
  if (!tx || tx.validated !== true || typeof tx.ledgerIndex !== "number" || !Number.isInteger(tx.ledgerIndex)) return null;
  if (!latest || typeof latest.ledgerIndex !== "number" || latest.ledgerIndex < tx.ledgerIndex) return null;
  return tx.ledgerIndex;
}
const runKey = (e) => `${e.label || ""}|${e.hash || ""}|${e.engineResult || ""}`;
let liveStream = null;
function closeLiveStream() {
  if (liveStream) { liveStream.close(); liveStream = null; }
}
/**
 * Run a level part as a background job and poll for it. A level can take minutes (Level 7 waits
 * ~4 minutes); a phone drops one long fetch when the screen locks, so the page asks every few
 * seconds instead and simply keeps asking after a dropped connection.
 * A live stream (when the browser has EventSource) pushes each step and each ledger close
 * between polls. The poll stays the source of truth if that stream drops.
 */
async function runLevel(id, part, onWait, onLive) {
  const path = `/api/levels/${id}/${part === "goal" ? "goal" : "should-fail"}`;
  let job, drops = 0;
  for (;;) {
    try { job = await api(path, { player: me(), world: addr(), async: true }); break; }
    catch (e) { if (!(e instanceof NetError) || ++drops > 5) throw e; onWait?.("Connection dropped. Trying again…"); await sleep(3000); }
  }
  const events = [];
  let ledger = null;
  const publish = () => onLive?.({ events: events.slice(), ledger });
  const push = (raw) => {
    const step = takeRun(raw);
    if (!step) return;
    const key = runKey(step);
    if (events.some((x) => runKey(x) === key)) return;
    events.push(step);
    publish();
  };
  closeLiveStream();
  if (typeof EventSource === "function") {
    liveStream = new EventSource(`/api/jobs/${encodeURIComponent(job.job)}/stream`);
    liveStream.addEventListener("run", (e) => { try { push(JSON.parse(e.data)); } catch { /* a bad frame is skipped */ } });
    liveStream.addEventListener("ledger", (e) => {
      try {
        const tick = takeLedger(JSON.parse(e.data));
        if (!tick) return;
        ledger = tick;
        publish();
      } catch { /* a bad frame is skipped */ }
    });
  }
  publish();
  const t0 = Date.now();
  try {
    while (job.status === "running") {
      await sleep(3000);
      try {
        job = await api(`/api/jobs/${encodeURIComponent(job.job)}`);
        drops = 0;
        if (Array.isArray(job.events)) for (const ev of job.events) push(ev);
        onWait?.("");
      } catch (e) {
        if (!(e instanceof NetError)) throw e;
        onWait?.("Connection dropped. Still checking; the ledger keeps working.");
        if (Date.now() - t0 > 15 * 60_000) throw new Error("Lost touch with the server. Reload the page: your score is saved there.");
      }
    }
  } finally { closeLiveStream(); }
  if (job.status === "error") throw new Error(job.busy ? "The server is busy. Try again in a few seconds." : job.error || "That run failed.");
  return job.result;
}
async function refresh() {
  state = await api("/api/state" + wq());
  // No address yet: show a fresh circuit, never another world's progress.
  if (!addr()) state = { ...state, world: 0, score: 0, levels: state.levels.map((l) => ({ ...l, score: { goal: false, shouldFail: false } })) };
  render();
}
async function act(label, fn) {
  if (busy) return;
  busy = label; render();
  try { await fn(); } finally { busy = null; await refresh().catch(() => render()); }
}

// ---- routing: #/map (home), #/level/<id>, #/tools ----
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("level/")) return { name: "level", id: decodeURIComponent(h.slice(6)) };
  if (h === "tools") return { name: "tools" };
  if (h === "graduate") return { name: "graduate" };
  return { name: "map" };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
let lastScreen = "";

function render() {
  if (!state) return;
  // Exposed for tests and the e2e player: non-empty while a request is in flight.
  document.body.dataset.busy = busy || "";
  syncCelebrateFlag();
  const r = route();
  const s = state;
  const seat = Object.values(s.seats).find((x) => addr() && x.wallet === addr()) || Object.values(s.seats).find((x) => x.player && x.player === me());
  $("stats").replaceChildren(
    el("span", { class: "pill" }, el("span", { class: "k" }, "Network "), el("b", {}, s.network)),
    el("span", { class: "pill" }, el("span", { class: "k" }, "Score "), el("b", {}, `${s.score}/${s.maxScore}`)),
    el("span", { class: "pill" }, el("span", { class: "k" }, "Seat "), el("b", {}, seat?.role || "no seat")));
  $("nav-map").toggleAttribute("aria-current", r.name === "map");
  if (r.name === "map") $("nav-map").setAttribute("aria-current", "page");
  $("nav-tools").toggleAttribute("aria-current", r.name === "tools");
  if (r.name === "tools") $("nav-tools").setAttribute("aria-current", "page");

  // Each card is its own screen: a new route or a new card always starts at the top.
  const screenKey = r.name + (r.id || "") + (r.name === "level" ? ":" + (ui.step[r.id] ?? 0) : "");
  const out = r.name === "level" ? levelScreen(r.id) : r.name === "tools" ? toolsScreen() : r.name === "graduate" ? graduateScreen() : mapScreen();
  if (!out) return;
  $("screen").replaceChildren(...out.nodes.filter(Boolean));
  $("screen").classList.toggle("pin-nav", !!out.pinNav);
  if (screenKey !== lastScreen) { lastScreen = screenKey; window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }
  requestAnimationFrame(() => { pointer.set(out.target, out.hint); paintCelebrate(); });
  scheduleCelebrate();
}

// ---- guided pointer: flashing arrow + highlight ring on exactly the next thing to click ----
const pointer = {
  target: null, key: "",
  set(target, hint) {
    document.querySelectorAll(".target").forEach((x) => x.classList.remove("target"));
    this.target = target && target.isConnected ? target : null;
    const key = (hint || "") + "|" + (this.target ? this.target.dataset.pt || this.target.textContent : "");
    $("hint").textContent = hint || "";
    if (!this.target) { $("pointer").style.display = "none"; this.key = key; return; }
    this.target.classList.add("target");
    this.place();
    if (key !== this.key) {
      this.key = key;
      const typing = document.activeElement && document.activeElement.tagName === "INPUT";
      if (!typing) this.target.focus({ preventScroll: true });
      const r = this.target.getBoundingClientRect();
      // Only scroll when the target is below the fold, and never so far that the card title
      // (or the top of the screen) leaves the view.
      if (r.bottom > innerHeight - 10) {
        const title = document.getElementById("cardtitle") || $("screen");
        const maxY = title.getBoundingClientRect().top + scrollY - 64;
        const y = Math.max(0, Math.min(r.bottom + scrollY - innerHeight + 16, maxY));
        if (y > scrollY) window.scrollTo({ top: y, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
      }
      setTimeout(() => this.place(), 350);
    }
  },
  place() {
    const p = $("pointer");
    if (!this.target || !this.target.isConnected) { p.style.display = "none"; return; }
    const r = this.target.getBoundingClientRect();
    p.style.display = "block";
    const pw = p.offsetWidth || 40, ph = p.offsetHeight || 48;
    if (this.target.classList.contains("choices")) {
      // A group of answers: point down at its top edge, never beside one answer (that would hint).
      p.className = "";
      p.style.left = `${Math.round(r.right - pw - 18 + scrollX)}px`;
      p.style.top = `${Math.round(r.top + scrollY - ph + 6)}px`;
      return;
    }
    const top = `${Math.round(r.top + scrollY + r.height / 2 - ph / 2)}px`;
    if (r.left > pw + 20 && r.width < innerWidth * 0.6) { // room on the left: point right at it
      p.className = "side";
      p.style.left = `${Math.round(r.left + scrollX - pw - 12)}px`;
      p.style.top = top;
      return;
    }
    // Narrow screens: the arrow sits at the target's inner right edge, pointing left, so it never
    // covers text above the target or a neighbouring button (targets are full-width there).
    p.className = "side-r";
    p.style.left = `${Math.round(r.right - pw - 6 + scrollX)}px`;
    p.style.top = top;
  },
};
addEventListener("resize", () => pointer.place());

// ---- level-complete celebration: the map switch snaps, then the path lights, then Continue ----
// Armed only after the player taps Continue. The animation may play; it never changes the route.
let celebrate = null; // { id, t0, skipped, reduce, timer }
function armCelebrate(id) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  clearTimeout(celebrate?.timer);
  celebrate = { id, t0: 0, skipped: reduce, reduce, timer: 0 };
}
function frameNow() {
  if (!celebrate) return null;
  if (!celebrate.t0) celebrate.t0 = performance.now();
  return celebrateFrame(performance.now() - celebrate.t0, { skipped: celebrate.skipped, reduce: celebrate.reduce });
}
function syncCelebrateFlag() {
  const frame = frameNow();
  if (celebrate && frame) {
    document.body.dataset.celebrate = celebrate.id;
    if (frame.showContinue) document.body.dataset.animDone = "1";
    else delete document.body.dataset.animDone;
  } else {
    delete document.body.dataset.celebrate;
    delete document.body.dataset.animDone;
  }
  return frame;
}
function scheduleCelebrate() {
  if (!celebrate) return;
  clearTimeout(celebrate.timer);
  const frame = frameNow();
  if (!frame || frame.showContinue) return;
  const elapsed = performance.now() - celebrate.t0;
  const at = elapsed < CELEBRATE_SWITCH_MS ? CELEBRATE_SWITCH_MS : CELEBRATE_TOTAL_MS;
  celebrate.timer = setTimeout(() => { if (celebrate) celebrate.timer = 0; render(); }, Math.max(16, at - elapsed + 16));
}
function paintCelebrate() {
  const frame = frameNow();
  if (!frame || !celebrate || celebrate.reduce || celebrate.skipped) return;
  if (frame.phase === "switch") {
    const lever = document.querySelector(".node.just-closed .lever");
    if (lever && !lever.getAnimations().length) {
      // CSS owns the spin. Leaving the SVG attribute on would stack a second rotation.
      lever.removeAttribute("transform");
      lever.style.transformOrigin = "0% 50%";
      lever.style.transformBox = "fill-box";
      const remain = Math.max(200, CELEBRATE_SWITCH_MS - (performance.now() - celebrate.t0));
      lever.animate([
        { transform: "rotate(-30deg)" },
        { transform: "rotate(8deg)", offset: 0.82 },
        { transform: "rotate(0deg)" },
      ], { duration: remain, easing: "cubic-bezier(.2,.8,.3,1.25)", fill: "forwards" });
    }
  }
  if (frame.phase === "path") {
    const path = document.querySelector(".trace.draw");
    if (path && !path.getAnimations().length) {
      const remain = Math.max(200, CELEBRATE_TOTAL_MS - (performance.now() - celebrate.t0));
      path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: remain, easing: "linear", fill: "forwards" });
    }
  }
}
function leaveCelebrate() {
  const id = celebrate?.id;
  clearTimeout(celebrate?.timer);
  celebrate = null;
  const l = state?.levels?.find((x) => x.id === id);
  const nx = l ? nextLevelAfter(l) : null;
  if (nx) { ui.step[nx.id] = ui.step[nx.id] || 0; saveUi(); go(`#/level/${nx.id}`); }
  else render();
}
// Any tap during the animation skips to the end state. The click from that same tap is swallowed
// so it doesn't also open a node; Continue takes a second tap.
addEventListener("pointerdown", (e) => {
  if (!celebrate) return;
  const frame = frameNow();
  if (!frame || frame.showContinue) return;
  e.preventDefault();
  e.stopPropagation();
  celebrate.skipped = true;
  celebrate.swallow = true;
  clearTimeout(celebrate.timer);
  render();
}, true);
addEventListener("click", (e) => {
  if (!celebrate?.swallow) return;
  celebrate.swallow = false;
  e.preventDefault();
  e.stopPropagation();
}, true);

// ---- home: the circuit board (switches on a ring around the core chip) ----
function mapScreen() {
  const ms = mapState(state.levels, { walletDone: walletDone(), read: ui.read });
  const frame = frameNow();
  const finished = frame ? state.levels.find((x) => x.id === celebrate.id) : null;
  const nextPlay = finished ? nextLevelAfter(finished) : null;
  const lightTo = frame ? (nextPlay ? nextPlay.id : "lamp") : null;
  const N = ms.nodes.length;
  const L = ringLayout(N);
  const g = [];
  // board: green PCB with a via grid and a copper edge
  g.push(svg("defs", {},
    svg("pattern", { id: "vias", width: 22, height: 22, patternUnits: "userSpaceOnUse" }, svg("circle", { cx: 11, cy: 11, r: 1.4, class: "via" })),
    svg("radialGradient", { id: "coreglow" }, svg("stop", { offset: "0%", "stop-color": "#fff6c9" }), svg("stop", { offset: "100%", "stop-color": "#ffd34d", "stop-opacity": "0" }))));
  g.push(svg("rect", { class: "board", x: 4, y: 4, width: L.w - 8, height: L.h - 8, rx: 26 }));
  g.push(svg("rect", { class: "board-grid", x: 4, y: 4, width: L.w - 8, height: L.h - 8, rx: 26, fill: "url(#vias)" }));
  for (const [x, y] of [[24, 24], [L.w - 24, 24], [24, L.h - 24], [L.w - 24, L.h - 24]]) g.push(svg("circle", { class: "mount", cx: x, cy: y, r: 8 }));
  // spokes: core -> each switch (lit when that level is done)
  ms.nodes.forEach((nd, i) => {
    const p = L.pos(i), k = 0.42;
    const sx = L.cx + (p.x - L.cx) * k, sy = L.cy + (p.y - L.cy) * k;
    g.push(svg("path", { class: "spoke" + (nd.closed || (i === 0) ? " lit" : ""), d: `M${sx.toFixed(1)} ${sy.toFixed(1)} L${p.x.toFixed(1)} ${p.y.toFixed(1)}` }));
  });
  // ring traces: node i-1 -> i lit when power reaches i; the closing arc lights on completion.
  // During a celebration the path to the next level stays dark until the switch has snapped.
  ms.traces.forEach((t, i) => {
    if (i === 0) return; // power enters at Level 0 through its spoke
    const d = i < N ? ringArc(L, i - 1, i) : ringArc(L, N - 1, 0);
    const drawing = frame && t.to === lightTo;
    const held = drawing && !frame.pathLit;
    const lit = (t.lit && !held) || (drawing && frame.pathLit);
    g.push(svg("path", {
      class: "trace" + (lit ? " lit" : "") + (drawing && !frame.showContinue ? " draw" : ""), d,
      ...(drawing && !frame.showContinue ? { pathLength: "1", "stroke-dasharray": "1", "stroke-dashoffset": "1" } : {}),
    }));
    if (lit && !(drawing && !frame.showContinue)) g.push(svg("path", { class: "flow", d }));
  });
  // core chip with pins
  const cs = 104, cx0 = L.cx - cs / 2, cy0 = L.cy - cs / 2;
  const pins = [];
  for (let k = 0; k < 6; k++) {
    const o = 14 + k * 15.2;
    pins.push(svg("rect", { class: "pin", x: cx0 + o, y: cy0 - 9, width: 6, height: 9 }), svg("rect", { class: "pin", x: cx0 + o, y: cy0 + cs, width: 6, height: 9 }),
      svg("rect", { class: "pin", x: cx0 - 9, y: cy0 + o, width: 9, height: 6 }), svg("rect", { class: "pin", x: cx0 + cs, y: cy0 + o, width: 9, height: 6 }));
  }
  g.push(svg("g", { class: "core" + (ms.allComplete ? " on" : "") },
    ms.allComplete ? svg("circle", { cx: L.cx, cy: L.cy, r: 92, fill: "url(#coreglow)", class: "corehalo" }) : null,
    ...pins,
    svg("rect", { class: "chip", x: cx0, y: cy0, width: cs, height: cs, rx: 10 }),
    svg("circle", { class: "chipdot", cx: cx0 + 14, cy: cy0 + 14, r: 4 }),
    svg("text", { class: "chiplabel", x: L.cx, y: L.cy - 12 }, "CORE"),
    svg("text", { class: "chipcount", x: L.cx, y: L.cy + 16 }, `${ms.doneCount}/${ms.total}`),
    svg("text", { class: "chipsub", x: L.cx, y: L.cy + 34 }, ms.allComplete ? "POWERED" : "switches"),
    svg("title", {}, `Core chip: ${ms.doneCount} of ${ms.total} switches closed`)));
  // switches on the ring
  for (const [i, nd] of ms.nodes.entries()) {
    const { x, y, a } = L.pos(i);
    const lab = L.label(i);
    const statusText = { done: "complete", current: nd.partial ? "in progress" : "next", locked: "locked", soon: "coming soon on this network" }[nd.status];
    const open = () => {
      if (nd.status === "locked") { $("hint").textContent = `Locked. Close the ${ms.nodes.find((z) => z.id === ms.current)?.short || "current"} switch first.`; return; }
      go(`#/level/${nd.id}`);
    };
    const deg = (a * 180) / Math.PI + 90; // lever runs along the ring
    const just = frame && nd.id === celebrate.id;
    const swinging = just && !frame.switchClosed;
    g.push(svg("g", {
      class: `node ${nd.status}` + (just ? " just-closed" : ""), tabindex: nd.status === "locked" ? "-1" : "0", role: "button",
      "aria-label": `Level ${nd.n}: ${nd.short}, ${statusText}`, "data-pt": `node-${nd.id}`,
      on: { click: open, keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } },
    },
      svg("circle", { class: "ring", cx: x, cy: y, r: 30 }),
      svg("circle", { class: "pad", cx: x, cy: y, r: 25 }),
      svg("g", { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)})` },
        svg("circle", { class: "contact", cx: -11, cy: 0, r: 4 }),
        svg("circle", { class: "contact", cx: 11, cy: 0, r: 4 }),
        svg("line", { class: "lever", x1: -11, y1: 0, x2: 11, y2: 0, transform: nd.closed && !swinging ? null : "rotate(-30 -11 0)" })),
      nd.partial ? svg("circle", { class: "partial", cx: x + 18, cy: y - 18, r: 5 }) : null,
      svg("circle", { class: "tag", cx: L.badge(i).x, cy: L.badge(i).y, r: 8 }),
      svg("text", { class: "tagnum", x: L.badge(i).x, y: L.badge(i).y + 3.5, "text-anchor": "middle" }, String(nd.n)),
      svg("text", { class: "lab", x: lab.x, y: lab.y, "text-anchor": lab.anchor }, nd.short),
      svg("title", {}, `Level ${nd.n}: ${nd.title} (${statusText})`)));
  }
  const map = svg("svg", {
    class: "circuit" + (ms.allComplete ? " complete" : "") + (frame ? " celebrating" : ""),
    viewBox: `0 0 ${L.w} ${L.h}`, role: "group", "data-phase": frame ? frame.phase : null,
    "data-anim-done": frame?.showContinue ? "1" : null,
    "aria-label": `Level map: ${ms.doneCount} of ${ms.total} switches closed`,
  }, g);
  const cur = ms.nodes.find((z) => z.id === ms.current);
  // "Start" only for a world with no progress at all; a world waiting on quizzes says Continue.
  const fresh = ms.doneCount === 0 && !ui.step.wallet && !state.score && !quizPending(state.levels, { walletDone: walletDone(), read: ui.read }).length;
  const gradBtn = ms.allComplete && !frame ? el("button", { class: "primary big", "data-pt": "graduate", on: { click: () => go("#/graduate") } }, "🎓 Get your graduate card") : null;
  const startBtn = !frame && cur ? el("button", { class: "primary big", "data-pt": "start", on: { click: () => go(`#/level/${cur.id}`) } },
    fresh ? "Start" : `Continue: Level ${cur.n} · ${cur.short}`) : null;
  const contBtn = frame?.showContinue ? el("button", { class: "primary big", "data-pt": "continue-next", on: { click: leaveCelebrate } }, nextPlay ? "Continue to the next level" : "Continue") : null;
  const nodes = [
    el("div", { class: "maphead" },
      el("div", {}, el("h1", {}, "Your circuit"),       el("p", {}, ms.allComplete ? "All switches closed. The core is powered." : `${ms.doneCount} of ${ms.total} switches closed. Close them all to power the core.`)),
      contBtn || startBtn || gradBtn),
    ms.allComplete && !frame ? el("div", { class: "banner", role: "status" }, "Circuit complete! The core is powered. Tap any switch to replay it.") : null,
    (() => {
      // Worlds that finished steps before quizzes existed: say why those switches are open again.
      const pend = quizPending(state.levels, { walletDone: walletDone(), read: ui.read });
      if (!pend.length || ms.allComplete) return null;
      const names = pend.map((x) => `Level ${x.n}`).join(", ");
      return el("div", { class: "banner", role: "status" }, `Quiz waiting: ${names}. Your level points are kept; a switch closes once its 3-question quiz is passed.`);
    })(),
    map,
  ];
  return {
    nodes,
    target: contBtn || startBtn || gradBtn,
    hint: frame ? (contBtn ? "Press Continue to the next level." : "Watch the switch close. Tap to skip.") : ms.allComplete ? "You graduated! Get your card." : fresh ? "Start here: press Start." : `Next: Level ${cur.n} (${cur.short}). Press Continue.`,
  };
}

// ---- level screens: short step cards ----
function levelScreen(id) {
  const l = state.levels.find((x) => x.id === id);
  if (!l) { go("#/map"); return null; }
  const ctx = { walletDone: walletDone(), read: ui.read };
  const gate = canOpen(state.levels, id, ctx);
  if (!gate.ok) return lockedScreen(l, state.levels.find((x) => x.id === gate.current));
  const cards = cardsFor(l);
  // Never past the first card you can't pass yet (an unrun step or an unanswered quiz question).
  let idx = clampStep(ui.step[id] ?? 0, cards.map((c) => !!c.nextDisabled));
  const c = cards[idx];
  const isLast = idx === cards.length - 1;
  const setIdx = (i) => { ui.step[id] = i; saveUi(); render(); };
  const back = el("button", { class: "big", "data-pt": "back", on: { click: () => (idx > 0 ? setIdx(idx - 1) : go("#/map")) } }, idx > 0 ? "← Back" : "← Map");
  const nextFn = c.nextDisabled
    // Not answered yet: Next stays on this card, back at its top, and says what to do.
    ? () => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); $("hint").textContent = c.hint || ""; }
    : c.hold
      // A finished run stays on this card until Continue. Advance from the card on screen.
      ? () => { c.next?.(); setIdx(idx + 1); }
      : c.next || (() => (isLast ? go("#/map") : setIdx(idx + 1)));
  const next = el("button", {
    class: "primary big" + (c.nextDisabled ? " is-off" : ""), "data-pt": `next-${idx}`,
    ...(c.hold ? { "data-continue": "run" } : {}),
    ...(c.continueKind ? { "data-continue": c.continueKind } : {}),
    ...(busy ? { disabled: true } : {}), ...(c.nextDisabled ? { "aria-disabled": "true" } : {}), on: { click: nextFn },
  }, c.nextLabel || (isLast ? "Map" : "Next →"));
  keys.back = () => back.click();
  keys.next = () => { if (!next.disabled) next.click(); };
  const more = c.more === false ? null : el("details", { class: "more" }, el("summary", {}, "Learn more"),
    c.moreText ? el("ul", {}, c.moreText.map((t) => el("li", {}, t))) : null,
    el("p", {}, ...l.docs.flatMap((d, i) => [i ? " · " : "", link(d.href, d.title)])));
  const nodes = [
    el("div", { class: "crumbs" }, el("span", {}, `Level ${l.n} · ${l.title}`),
      el("div", { class: "dots", "aria-label": `Step ${idx + 1} of ${cards.length}` }, cards.map((_, i) => el("span", { class: "dot" + (i === idx ? " on" : i < idx ? " past" : "") })))),
    el("section", { class: "card", "aria-labelledby": "cardtitle" },
      el("h2", { id: "cardtitle" }, c.title), c.diag ? diagram(c.diag) : null, ...c.body, more),
    el("div", { class: "navrow" + (c.hold ? " pinned" : "") }, back, next),
  ];
  const target = busy ? null : c.hold ? next : c.target && c.target() ? c.target() : c.nextDisabled ? null : next;
  const hint = busy ? (busy === "quiz" ? "Checking your answer…" : "Working on the ledger…")
    : c.hold ? (c.hint || "Read the run, then press Continue.")
    : c.target && c.target() ? c.hint
    : c.nextDisabled ? (c.hint || "")
    : isLast ? (c.nextHint || "All set. Press the button to continue.")
    : "Press Next →";
  return { nodes, target, hint, pinNav: !!c.hold };
}

/** A level whose earlier switch is still open: say so and point at the level to play. */
function lockedScreen(l, cur) {
  const btn = cur ? el("button", { class: "primary big", "data-pt": "to-current", on: { click: () => go(`#/level/${cur.id}`) } }, `Go to Level ${cur.n}`) : null;
  keys.back = () => go("#/map"); keys.next = () => btn?.click();
  return {
    nodes: [
      el("div", { class: "crumbs" }, el("span", {}, `Level ${l.n} · ${l.title}`)),
      el("section", { class: "card", "aria-labelledby": "cardtitle" }, el("h2", { id: "cardtitle" }, "Locked"),
        el("p", { class: "lead" }, cur ? `Finish Level ${cur.n} (${cur.title}) first: its steps and its quiz close that switch and unlock the next one.` : "Finish the earlier levels first.")),
      el("div", { class: "navrow" }, el("button", { class: "big", "data-pt": "back", on: { click: () => go("#/map") } }, "← Map"), btn),
    ],
    target: btn, hint: cur ? `Level ${cur.n} comes first. Press the button.` : "",
  };
}

const keys = { back: null, next: null };
addEventListener("keydown", (e) => {
  if (route().name !== "level" || e.altKey || e.ctrlKey || e.metaKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SUMMARY") return;
  if (e.key === "ArrowRight") { e.preventDefault(); keys.next?.(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); keys.back?.(); }
  else if (e.key === "Escape") go("#/map");
  else if (e.key === "Enter" && (tag === "BODY" || tag === "MAIN" || tag === "SECTION")) { e.preventDefault(); keys.next?.(); }
});

function fill(t) {
  const net = state.network;
  return String(t).replaceAll("{network}", net).replaceAll("{Network}", net[0].toUpperCase() + net.slice(1));
}
function nextLevelAfter(l) {
  const order = [...state.levels].sort((a, b) => a.n - b.n);
  return order.find((x) => x.n > l.n && x.available !== false) || null;
}
const TODO_TEXT = { wallet: "Build your world and claim a seat", goal: "Run the goal", shouldFail: "Try the should-fail step", quiz: "Take the quiz", read: "Read the explainer" };
/** "What's left" card for a level that isn't done: no way forward, one button back to the step. */
function todoCard(l, title, lead, todoIdx) {
  const todo = levelTodo(l, { walletDone: walletDone(), read: ui.read });
  const label = TODO_TEXT[todo] || "Back to the steps";
  return {
    title, body: [el("p", { class: "lead" }, lead), el("p", { class: "note" }, `Left to do: ${label.toLowerCase()}. Level ${l.n + 1} unlocks after this level's quiz.`)], more: false,
    nextLabel: `← ${label}`, nextHint: `${label} first. Press the button.`,
    next: () => { ui.step[l.id] = todoIdx; saveUi(); render(); },
  };
}
function finishCard(l, title, lead) {
  const nx = nextLevelAfter(l);
  return {
    title, body: [el("p", { class: "lead" }, lead)], more: false, diag: "done",
    continueKind: "level",
    nextLabel: "Continue",
    nextHint: nx ? `Next: Level ${nx.n}. Press Continue.` : "Back to your circuit. Press Continue.",
    // The tap opens the map. The switch animation plays there and does not move on by itself.
    next: () => { armCelebrate(l.id); go("#/map"); },
  };
}

function cardsFor(l) {
  if (l.available === false) {
    return [{ title: "Coming soon", body: [el("p", { class: "lead" }, `${l.feature} isn't enabled on ${state.network} yet.`), el("p", { class: "note" }, "The game checks this live and unlocks the level when it is.")] }];
  }
  const kind = levelKind(l);
  if (kind === "onboarding") return walletCards(l);
  if (kind === "explainer") {
    const parts = (l.explainer || []).map((t, i) => ({ title: i === 0 ? l.title.replace(/^Explainer:\s*/i, "") : `Part ${i + 1}`, body: [el("p", { class: "lead" }, t)], more: i === 0 ? undefined : false, diag: `${l.id}:p${i}` }));
    if (l.quiz) {
      const qz = quizCards(l, parts.length);
      return [...parts, ...qz.cards, qz.finish(finishCard(l, "Switch closed ✓", `Quiz passed: ${l.quiz.points} of ${l.quiz.maxPoints} first-try points. Score ${state.score}/${state.maxScore}.`))];
    }
    const done = finishCard(l, "Explainer read ✓", "That switch is closed. Back to your circuit.");
    const nextFn = done.next;
    done.next = () => { if (!ui.read.includes(l.id)) ui.read.push(l.id); saveUi(); nextFn(); };
    done.nextLabel = "Close the switch";
    done.nextHint = "Press Close the switch.";
    return [...parts, done];
  }
  return scoredCards(l);
}

// ---- quiz gate: 3 questions, one per card; answers are checked on the server ----
function quizCards(l, firstIdx) {
  const qz = l.quiz;
  if (!qz) return { cards: [], finish: (f) => f };
  const n = qz.questions.length;
  const right = qz.answers.filter((a) => a.correct).length;
  const over = qz.answers.length >= n;
  const answer = (i, k) => act("quiz", async () => {
    try {
      const res = await api("/api/quiz/answer", { world: addr(), level: l.id, q: i, choice: k });
      quizMsg[l.id] = "";
      // A passed quiz stays on this question so the result can be read. Continue is the way on.
      if (res && res.view) state = res.view;
    } catch (e) { quizMsg[l.id] = e.message; }
  });
  const retry = () => act("quiz", async () => {
    try { await api("/api/quiz/retry", { world: addr(), level: l.id }); ui.step[l.id] = firstIdx; saveUi(); quizMsg[l.id] = ""; }
    catch (e) { quizMsg[l.id] = e.message; }
  });
  if (!qz.unlocked) {
    return { cards: [], finish: () => todoCard(l, "Quiz locked", l.n === 0 || !state.world ? "Build your world in Level 0 first. The quiz runs in your own world." : "Finish this level's steps first.", l.n === 0 ? 4 : 2) };
  }
  const cards = qz.questions.map((q, i) => {
    const a = qz.answers[i];
    let group;
    const blocked = !qz.passed && i > qz.answers.length;
    const buttons = q.choices.map((c, k) => el("button", {
      class: "choice" + (a && a.choice === k ? (a.correct ? " right" : " wrong") : ""), "data-pt": `quiz-choice-${k}`,
      ...(a || qz.passed || blocked || over || busy ? { disabled: true } : {}), on: { click: () => answer(i, k) },
    }, (a && a.choice === k ? (a.correct ? "✓ " : "✗ ") : "") + c));
    return {
      title: `Quiz ${i + 1} of ${n}`, diag: null, more: false,
      body: [
        el("p", { class: "lead" }, q.q),
        group = el("div", { class: "choices", role: "group", "data-pt": `quiz-choices-${i}`, "aria-label": `Question ${i + 1} choices` }, buttons),
        a ? el("p", { class: "result " + (a.correct ? "ok" : "bad"), role: "status" }, a.correct ? "Correct ✓" : `Not quite. Here's why: ${a.why}`) : null,
        blocked ? el("p", { class: "note" }, `Answer question ${qz.answers.length + 1} first.`) : null,
        busy === "quiz" && !a ? el("p", { class: "result", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), "Checking your answer…") : null,
        quizMsg[l.id] ? el("p", { class: "result bad", role: "alert" }, quizMsg[l.id]) : null,
        el("p", { class: "note" }, qz.passed ? `Quiz passed. First-try score: ${qz.points}/${qz.maxPoints}.`
          : qz.firstDone ? `Retry: pass with ${qz.pass} of ${n} to close the switch. Retries add no points (first try: ${qz.points}/${qz.maxPoints}).`
          : `Pass with ${qz.pass} of ${n}. ${QUIZ_PTS} points per right answer on your first try.`),
      ],
      nextDisabled: !a && !qz.passed && !over,
      // The flashing arrow points at the answers until one is picked (then at Next).
      target: () => (!a && !qz.passed && !over && !blocked && !busy ? group : null),
      hint: blocked ? `Answer question ${qz.answers.length + 1} first.` : "Pick an answer.",
    };
  });
  const finish = (f) => {
    if (qz.passed) return f;
    if (!over) return todoCard(l, "Finish the quiz", `${qz.answers.length} of ${n} answered.`, firstIdx + qz.answers.length);
    let btn;
    return {
      title: `Quiz: ${right} of ${n} right`, more: false,
      body: [el("p", { class: "lead" }, `You need ${qz.pass} of ${n} to close this switch. Read the why lines and try again.`),
        el("p", { class: "note" }, `Your first-try quiz points (${qz.points}/${qz.maxPoints}) are kept. A retry only closes the switch; it adds no points.`),
        el("div", { class: "act" }, btn = el("button", { class: "primary big", "data-pt": "quiz-retry", ...(busy ? { disabled: true } : {}), on: { click: retry } }, "Try again")),
        quizMsg[l.id] ? el("p", { class: "result bad", role: "alert" }, quizMsg[l.id]) : null],
      target: () => (busy ? null : btn), hint: "Press Try again.",
    };
  };
  return { cards, finish };
}
const quizMsg = {};
const QUIZ_PTS = 10;

function seatChips(roles) {
  const name = me();
  const world = addr();
  return el("div", { class: "chips" }, roles.map((role) => {
    const s = state.seats[role];
    const mine = s.player && s.player === name;
    if (mine) return el("button", { class: "chip mine", "data-pt": `leave-${role}`, on: { click: () => act("seat", () => api("/api/seat/release", { role, player: name, world })) } }, `✓ You: ${role} (leave)`);
    if (s.player) return el("button", { class: "chip", disabled: true }, `${role}: ${s.player}`);
    return el("button", { class: "chip", "data-pt": `claim-${role}`, ...(world && state.world && !busy ? {} : { disabled: true }), on: { click: () => act("seat", async () => {
      try { await W.claimWithWallet(role, name); } catch (e) { alert(e.message); }
    }) } }, `Play ${role}`);
  }));
}

const NET_NODES = 5;
function runLog(live) {
  const events = live?.events || [];
  const led = live?.ledger;
  const rows = events.length ? events.map((t) => {
    const mark = ledgerMark(t, led);
    const bits = [el("span", { class: "rl-label" }, t.label || "Transaction")];
    if (t.type) bits.push(el("span", { class: "rl-type" }, t.type));
    if (t.engineResult) bits.push(el("span", { class: String(t.engineResult).startsWith("tes") ? "res-tes" : "res-bad" }, t.engineResult));
    if (typeof t.hash === "string" && TX_HASH.test(t.hash) && state.explorer) bits.push(link(state.explorer + t.hash, t.hash.slice(0, 8) + "…"));
    if (mark != null) bits.push(el("span", { class: "rl-hit" }, `in ledger #${mark}`));
    return el("li", { class: "runline" + (mark != null ? " in-ledger" : "") }, bits);
  }) : [el("li", { class: "runline wait" }, "Steps show up here as the ledger answers.")];
  return el("ol", { class: "runlog", "data-run-log": "", "aria-live": "polite", "aria-label": "Level run" }, rows);
}
function networkPanel(live) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cx = 80, cy = 54, r = 36;
  const nodes = Array.from({ length: NET_NODES }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / NET_NODES;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  const parts = [];
  for (let i = 0; i < NET_NODES; i++) {
    const a = nodes[i], b = nodes[(i + 1) % NET_NODES];
    const x1 = a.x.toFixed(1), y1 = a.y.toFixed(1), x2 = b.x.toFixed(1), y2 = b.y.toFixed(1);
    parts.push(svg("line", { class: "net-link", x1, y1, x2, y2 }));
    if (!reduce) parts.push(svg("circle", { class: "net-pulse", r: "3", cx: x1, cy: y1 },
      svg("animate", { attributeName: "cx", values: `${x1};${x2}`, dur: `${(1.5 + i * 0.12).toFixed(2)}s`, repeatCount: "indefinite" }),
      svg("animate", { attributeName: "cy", values: `${y1};${y2}`, dur: `${(1.5 + i * 0.12).toFixed(2)}s`, repeatCount: "indefinite" })));
  }
  for (const n of nodes) parts.push(svg("circle", { class: "net-node", cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: "6" }));
  const led = live?.ledger;
  return el("div", { class: "netpanel" },
    svg("svg", { class: "netring", viewBox: "0 0 160 108", role: "img", "aria-label": "Validator nodes" }, parts),
    el("p", { class: "ledgetick", "data-ledger": led ? String(led.ledgerIndex) : "" }, led ? `Ledger closed #${led.ledgerIndex}` : "Waiting for a ledger close…"));
}
function resultBox(r) {
  if (!r) return null;
  const good = r.ok || (r.added ?? 0) > 0;
  return el("div", { class: "result " + (good ? "ok" : "bad"), role: "status" },
    r.message + (r.added ? ` (+${r.added} points)` : ""),
    r.results?.length ? el("div", {}, r.results.slice(-4).map((t) => link(state.explorer + t.hash, `${t.type} ${t.engineResult}`))) : null);
}

function scoredCards(l) {
  const res = (results[l.id] ||= {});
  const run = (part) => act(part, async () => {
    res.wait = "";
    res.live = { events: [], ledger: null };
    res.hold = null;
    try { res[part] = await runLevel(l.id, part, (m) => { if (res.wait !== m) { res.wait = m; render(); } }, (live) => { res.live = live; render(); }); }
    catch (e) { res[part] = { ok: false, message: "Error: " + e.message }; }
    res.wait = "";
    // The poll (and the live stream) finishing must not leave this card. Continue does.
    res.hold = part;
  });
  const waitNote = l.id === "lend" ? "This one waits for the vault's investment phase: usually about a minute, sometimes a few." : "Ledger steps take a few seconds each.";
  const liveView = (part) => {
    const running = busy === part;
    // Keep the log up after the job finishes, until Continue clears the hold.
    const held = res.hold === part;
    if (!running && !held) return null;
    return el("div", { class: "liverun" },
      running ? el("p", { class: "result", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), `Working on ${state.network}… ${waitNote}`, res.wait ? el("span", { class: "note" }, " " + res.wait) : null) : null,
      runLog(res.live), networkPanel(res.live));
  };
  const releaseHold = () => { res.hold = null; };
  const roleList = l.goalRoles.join(", ");

  let goalBtn, failBtn;
  const noWorld = !addr() || !state.world;
  const toLevel0 = () => { ui.step.wallet = 4; saveUi(); go("#/level/wallet"); };
  const cards = [
    { title: l.title, diag: `${l.id}:goal`, body: [el("p", { class: "lead" }, l.goal)], moreText: [l.bots, l.priority ? "Education Month priority level." : null].filter(Boolean) },
    {
      title: "Pick a seat (optional)", diag: "seat",
      body: [el("p", { class: "lead" }, `Seats in this level: ${roleList}. Bots play any seat you leave open.`), noWorld ? null : seatChips(l.goalRoles)],
      more: false,
    },
    {
      title: l.score.goal ? "Goal done ✓" : noWorld ? "Build your world first" : "Do it",
      body: [
        el("p", { class: "lead" }, l.score.goal ? "Your world already cleared the goal." : noWorld ? "Levels run in your own world. Build it in Level 0." : `Run the goal on ${state.network}. +10 points.`),
        el("div", { class: "act" }, goalBtn = noWorld
          ? el("button", { class: "primary big", "data-pt": "to-l0", on: { click: toLevel0 } }, "Go to Level 0")
          : el("button", { class: "primary big", "data-pt": "run-goal", ...(busy || l.score.goal ? { disabled: true } : {}), on: { click: () => run("goal") } }, "Run level")),
        liveView("goal"), resultBox(res.goal),
      ],
      more: false,
      hold: res.hold === "goal" && !!l.score.goal,
      nextLabel: res.hold === "goal" && l.score.goal ? "Continue" : undefined,
      next: res.hold === "goal" && l.score.goal ? releaseHold : undefined,
      target: () => (!l.score.goal && !busy ? goalBtn : null),
      nextDisabled: !l.score.goal, // the goal must clear before the level moves on
      hint: res.hold === "goal" ? "Read the run, then press Continue." : noWorld ? "Build your world in Level 0 first." : "Press Run level.",
    },
    {
      title: l.score.shouldFail ? "Broken on purpose ✓" : "Now break it", diag: `${l.id}:fail`,
      body: [
        el("p", { class: "lead" }, l.shouldFail),
        el("div", { class: "act" }, failBtn = el("button", { class: "primary big", "data-pt": "run-fail", ...(busy || !state.world || l.score.shouldFail ? { disabled: true } : {}), on: { click: () => run("shouldFail") } }, "Try it (+5)")),
        liveView("shouldFail"), resultBox(res.shouldFail),
        l.score.shouldFail && l.rejectReason ? el("p", { class: "note" }, "Why it fails: " + l.rejectReason) : null,
      ],
      more: false,
      hold: res.hold === "shouldFail" && !!l.score.shouldFail,
      nextLabel: res.hold === "shouldFail" && l.score.shouldFail ? "Continue" : undefined,
      next: res.hold === "shouldFail" && l.score.shouldFail ? releaseHold : undefined,
      target: () => (!l.score.shouldFail && !busy ? failBtn : null),
      nextDisabled: !l.score.shouldFail,
      hint: res.hold === "shouldFail" ? "Read the run, then press Continue." : "Press Try it. The ledger should refuse it.",
    },
  ];
  const pts = (l.score.goal ? 10 : 0) + (l.score.shouldFail ? 5 : 0) + (l.score.goal && l.score.shouldFail ? 5 : 0);
  const done = l.score.goal && l.score.shouldFail;
  if (!done) { cards.push(todoCard(l, "Almost there", `You have ${pts} of 20 points. Finish both steps, then a 3-question quiz closes this switch.`, l.score.goal ? 3 : 2)); return cards; }
  const qz = quizCards(l, cards.length);
  cards.push(...qz.cards, qz.finish(finishCard(l, "Switch closed ✓", `Level ${l.n} complete: ${pts} of 20 level points + ${l.quiz?.points ?? 0} of ${l.quiz?.maxPoints ?? 0} quiz points (first try). Score ${state.score}/${state.maxScore}.`)));
  return cards;
}

function walletCards(l) {
  const net = state.network;
  const address = W.currentAddress();
  const funded = !!l0.bal?.funded;
  const mySeat = Object.values(state.seats).find((s) => s.wallet && s.wallet === address);
  let genBtn, fundBtn, firstSeat, worldBtn;
  const startMyWorld = () => act("world", async () => {
    l0.worldMsg = "";
    try { await api("/api/world/start", { world: address }); } catch (e) { l0.worldMsg = e.message; }
  });
  const doFund = () => act("fund", async () => {
    l0.msg = `Asking the ${net} faucet…`;
    try { l0.bal = await W.fund(state.faucetHost, (m) => { l0.msg = m; render(); }); l0.msg = l0.bal?.funded ? `Funded: ${l0.bal.balanceXrp} test XRP on ${net}.` : "Not on the ledger yet. Wait a moment and try again."; }
    catch (e) { l0.msg = "Faucet error: " + e.message; }
  });
  return [
    {
      title: `What is ${net}?`, diag: "wallet:devnet",
      body: [],
      moreText: (l.explainer || []).map(fill),
    },
    {
      title: "Make your wallet", diag: "wallet:wallet",
      body: [
        el("p", { class: "lead" }, "Your browser makes a key pair. The secret (seed) never leaves this page."),
        el("div", { class: "act" }, genBtn = el("button", { class: "primary big", "data-pt": "gen", on: { click: () => { try { W.generateWallet(); l0.bal = null; l0.seedShown = false; l0.msg = ""; l0.worldMsg = ""; } catch (e) { l0.msg = e.message; } refresh().catch(() => render()); } } }, address ? "Make a new one" : "Generate wallet")),
        address ? el("p", {}, "Address: ", el("code", {}, address)) : null,
      ],
      more: false,
      target: () => (!address ? genBtn : null),
      nextDisabled: !address,
      hint: "Press Generate wallet.",
    },
    {
      title: "Save your seed", diag: "wallet:seed",
      body: W.hasSeedInMemory() ? [
        el("div", { class: "warnbox" }, "Test-only. Never reuse a test seed on mainnet. Reloading this page forgets it."),
        el("div", { class: "act" }, el("code", { class: "seed" }, l0.seedShown ? W.revealSeed() : "•••••••••••••"),
          el("button", { on: { click: () => { l0.seedShown = !l0.seedShown; render(); } } }, l0.seedShown ? "Hide" : "Show")),
      ] : [el("p", { class: "lead" }, address ? "Your seed was only shown in the page where you made it, and isn't stored." : "Make a wallet first."), el("p", { class: "note" }, "You can still use the address for this game.")],
      more: false,
    },
    {
      title: "Fund it", diag: "wallet:fund",
      body: [
        el("p", { class: "lead" }, "Ask the faucet for free test XRP."),
        el("div", { class: "act" }, fundBtn = el("button", { class: "primary big", "data-pt": "fund", ...(address && !busy ? {} : { disabled: true }), on: { click: doFund } }, funded ? "Fund again" : "Fund from faucet"),
          el("button", { ...(address && !busy ? {} : { disabled: true }), on: { click: () => act("bal", async () => { try { l0.bal = await W.balance(); l0.msg = l0.bal.funded ? `Live: ${l0.bal.balanceXrp} test XRP.` : "Not funded yet."; } catch (e) { l0.msg = e.message; } }) } }, "Check balance")),
        busy === "fund" ? el("p", { class: "result" }, el("span", { class: "spinner", "aria-hidden": "true" }), l0.msg) : l0.msg ? el("p", { class: "result " + (funded ? "ok" : ""), role: "status" }, l0.msg) : null,
      ],
      more: false,
      target: () => (address && !funded && !busy ? fundBtn : null),
      nextDisabled: !funded && !state.world, // a world already exists: its accounts are funded
      hint: address ? "Press Fund from faucet." : "Make a wallet first.",
    },
    state.world ? {
      title: mySeat?.wallet ? "Seat claimed ✓" : "Claim a seat", diag: "wallet:seat",
      body: (() => {
        const kids = [el("p", { class: "lead" }, mySeat?.wallet ? `You play ${mySeat.role} with your wallet.` : "Your address replaces a bot in one seat of your world.")];
        const chips = seatChips(Object.keys(state.seats));
        firstSeat = chips.querySelector("button:not(:disabled):not(.mine)");
        kids.push(chips);
        return kids;
      })(),
      more: false,
      target: () => (mySeat?.wallet ? null : firstSeat),
      nextDisabled: !mySeat?.wallet,
      hint: "Pick a seat.",
    } : {
      title: "Build your world", diag: "wallet:world",
      body: [
        el("p", { class: "lead" }, "Your progress and seats are yours alone."),
        el("div", { class: "act" }, worldBtn = el("button", { class: "primary big", "data-pt": "start-world", ...(address && !busy ? {} : { disabled: true }), on: { click: startMyWorld } }, "Start my world")),
        busy === "world" ? el("p", { class: "result", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), "Funding 6 test accounts from the faucet… about 30 seconds.") : null,
        l0.worldMsg ? el("p", { class: "result bad", role: "status" }, l0.worldMsg) : null,
        address ? null : el("p", { class: "note" }, "Make a wallet first: your world is keyed by its address."),
      ],
      more: false,
      target: () => (address && !busy ? worldBtn : null),
      nextDisabled: true, // the seat card replaces this one once the world exists
      hint: address ? "Press Start my world." : "Make a wallet first.",
    },
    ...(walletDone() && l.quiz ? (() => { const qz = quizCards(l, 5); return [...qz.cards, qz.finish(finishCard(l, "Wallet ready ✓", `Switch closed. Quiz: ${l.quiz.points} of ${l.quiz.maxPoints} first-try points. Level 1 is next.`))]; })()
      : [todoCard(l, "Wallet step", "Build your world and claim a seat with your wallet. Then a 3-question quiz closes this switch.", 4)]),
  ];
}

// ---- tools: network check, recent results, objects, restart my world ----
function toolsScreen() {
  const s = state, a = s.amendments;
  const objs = el("div", {});
  const nodes = [
    el("div", { class: "panel" }, el("h2", {}, "Network check"),
      el("p", {}, "Levels unlock only when their amendment is enabled (checked live). ",
        el("button", { ...(busy ? { disabled: true } : {}), on: { click: () => act("amend", () => api("/api/amendments", {})) } }, "Re-check")),
      a ? el("table", {}, el("tr", {}, el("th", {}, "Amendment"), el("th", {}, `Status on ${a.network}`)),
        Object.values(a.amendments).map((x) => el("tr", {}, el("td", {}, x.name), el("td", { class: x.enabled ? "res-tes" : "res-bad" }, x.enabled ? "enabled" : x.known ? "not enabled (may be in voting)" : "unknown to this server")))) : el("p", {}, "Not checked yet.")),
    el("div", { class: "panel" }, el("h2", {}, "Recent ledger results"),
      s.recent.length ? el("table", {}, el("tr", {}, ...["Level", "Type", "By", "Result", "Tx"].map((h) => el("th", {}, h))),
        s.recent.map((r) => el("tr", {}, el("td", {}, `${r.level} ${r.part}`), el("td", {}, r.type), el("td", {}, r.note || ""),
          el("td", { class: r.engineResult.startsWith("tes") ? "res-tes" : "res-bad" }, r.engineResult),
          el("td", {}, link(s.explorer + r.hash, r.hash.slice(0, 12) + "…"))))) : el("p", {}, "No transactions in this world yet."),
      ...s.bugs.map((b) => el("p", { class: "result bad" }, "Flagged: " + b))),
    el("div", { class: "panel" }, el("h2", {}, "Ledger objects"),
      el("button", { on: { click: async () => {
        objs.textContent = "Loading…";
        try {
          const o = await api("/api/objects" + wq());
          objs.replaceChildren(o.objects.length ? el("table", {}, el("tr", {}, ...["Owner", "Type", "Detail", "ID"].map((h) => el("th", {}, h))),
            o.objects.map((x) => el("tr", {}, el("td", {}, x.owner), el("td", {}, x.type), el("td", {}, x.detail), el("td", {}, x.id.slice(0, 12) + "…")))) : el("p", {}, "No objects yet."));
        } catch (e) { objs.textContent = "Error: " + e.message; }
      } } }, "Load objects"), objs),
    el("div", { class: "panel" }, el("h2", {}, "World"),
      el("p", {}, s.owner ? `Your world #${s.world} on ${s.network}, keyed by ${s.owner.slice(0, 8)}…` : `No world of your own yet. Build it in Level 0.`),
      s.owner && s.world ? el("button", { ...(busy ? { disabled: true } : {}), on: { click: () => {
        if (!confirm("Start over with a fresh world? Your progress in this world is cleared.")) return;
        act("reset", async () => { try { await api("/api/world/start", { world: addr(), fresh: true }); for (const k of Object.keys(results)) delete results[k]; } catch (e) { alert(e.message); } });
      } } }, "Restart my world") : null),
  ];
  return { nodes, target: null, hint: "" };
}

// ---- graduation: a shareable award card, verified and rendered on the server ----
const grad = { msg: "", card: null };
function graduateScreen() {
  const ms = mapState(state.levels, { walletDone: walletDone(), read: ui.read });
  if (!ms.allComplete || !addr()) {
    const b = el("button", { class: "primary big", "data-pt": "to-map", on: { click: () => go("#/map") } }, "Back to the map");
    return { nodes: [el("div", { class: "card" }, el("h2", {}, "Not graduated yet"), el("p", { class: "lead" }, `Close all ${ms.total} switches to get your graduate card. ${ms.doneCount} of ${ms.total} done.`), el("div", { class: "act" }, b))], target: b, hint: "Finish every level first." };
  }
  const id = grad.card?.id || state.award?.id || null;
  const name = el("input", { id: "grad-name", type: "text", maxlength: "32", autocomplete: "nickname", placeholder: "Your name or @handle", value: localStorage.getItem("dch-award-name") || "", "aria-label": "Name on your card" });
  const make = el("button", { class: id ? "big" : "primary big", "data-pt": "make-card", ...(busy ? { disabled: true } : {}), on: { click: () => act("award", async () => {
    try {
      const n = name.value.trim();
      localStorage.setItem("dch-award-name", n);
      grad.card = await api("/api/award", { world: addr(), name: n });
      grad.msg = "";
    } catch (e) { grad.msg = e.message; }
  }) } }, id ? "Update name" : "Make my card");
  const nodes = [el("div", { class: "card grad" },
    el("h2", {}, "🎓 Graduate"),
    el("p", { class: "lead" }, "You powered the full circuit. Put your name on your card and share it."),
    el("label", { for: "grad-name", class: "lab" }, "Name on your card (up to 32 characters)"),
    el("div", { class: "act" }, name, make),
    grad.msg ? el("p", { class: "result bad", role: "alert" }, grad.msg) : null)];
  let share = null;
  if (id) {
    const page = `${location.origin}/award/${id}`;
    const v = encodeURIComponent(grad.card?.name || localStorage.getItem("dch-award-name") || "");
    const score = grad.card?.score ?? state.score;
    const text = `I completed the XRPL Amendments Tutorial and powered the full circuit ⚡ Score: ${score}/${state.maxScore}. Learn XRPL dev hands-on on ${state.network} 👇 ${page} @XRPLF #XRPEducationMonth`;
    share = el("a", { class: "btn primary big", "data-pt": "share-x", href: "https://x.com/intent/post?text=" + encodeURIComponent(text), target: "_blank", rel: "noopener" }, "Share on X");
    nodes.push(el("div", { class: "card grad" },
      el("img", { class: "award-img", src: `/award/${id}.png?v=${v}`, width: "1200", height: "675", alt: "Your Graduate card: the fully lit circuit with the core powered" }),
      el("div", { class: "act" }, share, el("a", { class: "btn big", href: `/award/${id}.png`, download: "graduate.png" }, "Download image")),
      el("p", { class: "small" }, "Share opens X with the text filled in. Nothing is posted until you press Post. Your link: ", link(page, page))));
  }
  return { nodes, target: share || make, hint: share ? "Press Share on X, or download the image." : "Enter your name, then press Make my card." };
}

$("home").addEventListener("click", () => go("#/map"));
$("nav-map").addEventListener("click", () => go("#/map"));
$("nav-tools").addEventListener("click", () => go("#/tools"));
if ("scrollRestoration" in history) history.scrollRestoration = "manual"; // the browser must not restore an old offset onto a new card
addEventListener("hashchange", () => { render(); $("screen").focus({ preventScroll: true }); });
refresh().catch((e) => { $("screen").replaceChildren(el("p", { class: "result bad" }, "Server not reachable: " + e.message)); });
