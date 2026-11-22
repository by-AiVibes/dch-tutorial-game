// DCH game UI: a circuit-board level map (home) plus short step cards per level, with a
// guided pointer at the next thing to click. Uses textContent everywhere (no innerHTML with data).
// Only UI position is kept in localStorage (never a seed); game progress comes from the server,
// from the player's OWN world, keyed by their wallet address (?world=<address>).
import { mapState, layout, tracePath, levelKind } from "./mapstate.js";
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

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (r.status === 429 || r.status === 503) throw new Error(`The server is busy. Try again in ${r.headers.get("retry-after") || "a few"} seconds.`);
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function refresh() {
  state = await api("/api/state" + wq());
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
  return { name: "map" };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
let lastScreen = "";

function render() {
  if (!state) return;
  const r = route();
  const s = state;
  const seat = Object.values(s.seats).find((x) => x.player && x.player === me());
  $("stats").replaceChildren(
    el("span", { class: "pill" }, el("span", { class: "k" }, "Network "), el("b", {}, s.network)),
    el("span", { class: "pill" }, el("span", { class: "k" }, "Score "), el("b", {}, `${s.score}/${s.maxScore}`)),
    el("span", { class: "pill" }, el("span", { class: "k" }, "Seat "), el("b", {}, seat?.role || "no seat")));
  $("nav-map").toggleAttribute("aria-current", r.name === "map");
  if (r.name === "map") $("nav-map").setAttribute("aria-current", "page");
  $("nav-tools").toggleAttribute("aria-current", r.name === "tools");
  if (r.name === "tools") $("nav-tools").setAttribute("aria-current", "page");

  const screenKey = r.name + (r.id || "");
  const out = r.name === "level" ? levelScreen(r.id) : r.name === "tools" ? toolsScreen() : mapScreen();
  if (!out) return;
  $("screen").replaceChildren(...out.nodes.filter(Boolean));
  if (screenKey !== lastScreen) { lastScreen = screenKey; window.scrollTo(0, 0); }
  requestAnimationFrame(() => pointer.set(out.target, out.hint));
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
      if (r.top < 70 || r.bottom > innerHeight - 10) this.target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      setTimeout(() => this.place(), 350);
    }
  },
  place() {
    const p = $("pointer");
    if (!this.target || !this.target.isConnected) { p.style.display = "none"; return; }
    const r = this.target.getBoundingClientRect();
    p.style.display = "block";
    if (r.left > 60 && r.width < innerWidth * 0.6) { // room on the left: point right at it
      p.className = "side";
      p.style.left = `${Math.round(r.left + scrollX - 54)}px`;
      p.style.top = `${Math.round(r.top + scrollY + r.height / 2 - 24)}px`;
      return;
    }
    // No room on the left (narrow screens): point from the right, so the arrow never covers
    // the text above the target. Outside the target if there's room, else at its inner right edge.
    p.className = "side-r";
    const outside = r.right + 50 < innerWidth;
    p.style.left = `${Math.round((outside ? r.right + 4 : r.right - 46) + scrollX)}px`;
    p.style.top = `${Math.round(r.top + scrollY + r.height / 2 - 24)}px`;
  },
};
addEventListener("resize", () => { pointer.place(); if (route().name === "map") render(); });

// ---- home: the circuit map ----
function mapScreen() {
  const ms = mapState(state.levels, { walletDone: walletDone(), read: ui.read });
  const cols = innerWidth >= 700 ? 3 : 2;
  const L = layout(ms.nodes.length, cols);
  const P = (slot) => L.pos(slot);
  const g = [];
  ms.traces.forEach((t, i) => {
    const d = tracePath(P(i - 1), P(i));
    g.push(svg("path", { class: "trace" + (t.lit ? " lit" : ""), d }));
    if (t.lit) g.push(svg("path", { class: "flow", d }));
  });
  const pw = P(-1);
  g.push(svg("g", { class: "power", transform: `translate(${pw.x} ${pw.y})` },
    svg("circle", { r: 26 }), svg("path", { d: "M3 -16 L-9 3 H0 L-3 16 L9 -3 H0 Z", fill: "#ffd34d" }),
    svg("title", {}, "Power")));
  const lp = P(ms.nodes.length);
  g.push(svg("g", { class: "lamp", transform: `translate(${lp.x} ${lp.y})` },
    svg("circle", { r: 30 }), svg("text", { y: 7 }, ms.allComplete ? "✓" : "★"), svg("title", {}, "Circuit complete lamp")));
  let currentNode = null;
  for (const [i, n] of ms.nodes.entries()) {
    const { x, y } = P(i);
    const statusText = { done: "complete", current: n.partial ? "in progress" : "next", locked: "locked", soon: "coming soon on this network" }[n.status];
    const open = () => {
      if (n.status === "locked") { $("hint").textContent = `Locked. Close the ${ms.nodes.find((z) => z.id === ms.current)?.short || "current"} switch first.`; return; }
      go(`#/level/${n.id}`);
    };
    const node = svg("g", {
      class: `node ${n.status}`, transform: `translate(${x} ${y})`, tabindex: n.status === "locked" ? "-1" : "0", role: "button",
      "aria-label": `Level ${n.n}: ${n.short}, ${statusText}`, "data-pt": `node-${n.id}`,
      on: { click: open, keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } },
    },
      svg("circle", { class: "ring", r: 46 }),
      svg("rect", { class: "pad", x: -62, y: -40, width: 124, height: 80, rx: 14 }),
      svg("text", { class: "num", y: -24 }, `LEVEL ${n.n}`),
      svg("circle", { class: "contact", cx: -24, cy: 2, r: 6 }),
      svg("circle", { class: "contact", cx: 24, cy: 2, r: 6 }),
      svg("line", { class: "lever", x1: -24, y1: 2, x2: 24, y2: 2, transform: n.closed ? null : "rotate(-24 -24 2)" }),
      n.partial ? svg("circle", { class: "partial", cx: 50, cy: -28, r: 6 }) : null,
      svg("text", { y: 32 }, n.short),
      svg("title", {}, `Level ${n.n}: ${n.title} (${statusText})`));
    if (n.id === ms.current) currentNode = node;
    g.push(node);
  }
  const map = svg("svg", { class: "circuit" + (ms.allComplete ? " complete" : ""), viewBox: `0 0 ${L.w} ${L.h}`, role: "group", "aria-label": `Level map: ${ms.doneCount} of ${ms.total} switches closed` }, g);
  const cur = ms.nodes.find((z) => z.id === ms.current);
  const fresh = ms.doneCount === 0 && !ui.step.wallet;
  const startBtn = cur ? el("button", { class: "primary big", "data-pt": "start", on: { click: () => go(`#/level/${cur.id}`) } },
    fresh ? "Start" : `Continue: Level ${cur.n} · ${cur.short}`) : null;
  const nodes = [
    el("div", { class: "maphead" },
      el("div", {}, el("h1", {}, "Your circuit"), el("p", {}, `${ms.doneCount} of ${ms.total} switches closed. Each level you finish closes a switch.`)),
      startBtn),
    ms.allComplete ? el("div", { class: "banner", role: "status" }, "Circuit complete! Every level is done. Tap any switch to replay it.") : null,
    map,
  ];
  return {
    nodes,
    target: startBtn,
    hint: ms.allComplete ? "" : fresh ? "Start here: press Start." : `Next: Level ${cur.n} (${cur.short}). Press Continue.`,
  };
}

// ---- level screens: short step cards ----
function levelScreen(id) {
  const l = state.levels.find((x) => x.id === id);
  if (!l) { go("#/map"); return null; }
  const cards = cardsFor(l);
  let idx = Math.min(Math.max(ui.step[id] ?? 0, 0), cards.length - 1);
  const c = cards[idx];
  const isLast = idx === cards.length - 1;
  const setIdx = (i) => { ui.step[id] = i; saveUi(); render(); };
  const back = el("button", { class: "big", "data-pt": "back", on: { click: () => (idx > 0 ? setIdx(idx - 1) : go("#/map")) } }, idx > 0 ? "← Back" : "← Map");
  const nextFn = c.next || (() => (isLast ? go("#/map") : setIdx(idx + 1)));
  const next = el("button", { class: "primary big", "data-pt": `next-${idx}`, ...(busy ? { disabled: true } : {}), on: { click: nextFn } }, c.nextLabel || (isLast ? "Map" : "Next →"));
  keys.back = () => back.click();
  keys.next = () => { if (!next.disabled) next.click(); };
  const more = c.more === false ? null : el("details", { class: "more" }, el("summary", {}, "Learn more"),
    c.moreText ? el("ul", {}, c.moreText.map((t) => el("li", {}, t))) : null,
    el("p", {}, ...l.docs.flatMap((d, i) => [i ? " · " : "", link(d.href, d.title)])));
  const nodes = [
    el("div", { class: "crumbs" }, el("span", {}, `Level ${l.n} · ${l.title}`),
      el("div", { class: "dots", "aria-label": `Step ${idx + 1} of ${cards.length}` }, cards.map((_, i) => el("span", { class: "dot" + (i === idx ? " on" : i < idx ? " past" : "") })))),
    el("section", { class: "card", "aria-labelledby": "cardtitle" },
      el("h2", { id: "cardtitle" }, c.title), ...c.body, more),
    el("div", { class: "navrow" }, back, next),
  ];
  const target = busy ? null : c.target && c.target() ? c.target() : next;
  return { nodes, target, hint: busy ? "Working on the ledger…" : c.target && c.target() ? c.hint : isLast ? (c.nextHint || "All set. Press the button to continue.") : "Press Next →" };
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
function finishCard(l, title, lead) {
  const nx = nextLevelAfter(l);
  return {
    title, body: [el("p", { class: "lead" }, lead)], more: false,
    nextLabel: nx ? `Level ${nx.n} →` : "Back to the map",
    nextHint: nx ? `Next: Level ${nx.n}. Press the button.` : "Back to your circuit.",
    next: () => { if (nx) { ui.step[nx.id] = ui.step[nx.id] || 0; saveUi(); go(`#/level/${nx.id}`); } else go("#/map"); },
  };
}

function cardsFor(l) {
  if (l.available === false) {
    return [{ title: "Coming soon", body: [el("p", { class: "lead" }, `${l.feature} isn't enabled on ${state.network} yet.`), el("p", { class: "note" }, "The game checks this live and unlocks the level when it is.")] }];
  }
  const kind = levelKind(l);
  if (kind === "onboarding") return walletCards(l);
  if (kind === "explainer") {
    const parts = (l.explainer || []).map((t, i) => ({ title: i === 0 ? l.title.replace(/^Explainer:\s*/i, "") : `Part ${i + 1}`, body: [el("p", { class: "lead" }, t)], more: i === 0 ? undefined : false }));
    const done = finishCard(l, "Explainer read ✓", "That switch is closed. Back to your circuit.");
    const nextFn = done.next;
    done.next = () => { if (!ui.read.includes(l.id)) ui.read.push(l.id); saveUi(); nextFn(); };
    done.nextLabel = "Close the switch";
    done.nextHint = "Press Close the switch.";
    return [...parts, done];
  }
  return scoredCards(l);
}

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
    try { res[part] = await api(`/api/levels/${l.id}/${part === "goal" ? "goal" : "should-fail"}`, { player: me(), world: addr() }); }
    catch (e) { res[part] = { ok: false, message: "Error: " + e.message }; }
  });
  const waitNote = l.id === "lend" ? "This one waits for the vault's investment phase: about 4 minutes." : "Ledger steps take a few seconds each.";
  const working = (part) => busy === part ? el("p", { class: "result", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), `Working on ${state.network}… ${waitNote}`) : null;
  const roleList = l.goalRoles.join(", ");

  let goalBtn, failBtn;
  const noWorld = !state.world;
  const toLevel0 = () => { ui.step.wallet = 4; saveUi(); go("#/level/wallet"); };
  const cards = [
    { title: l.title, body: [el("p", { class: "lead" }, l.goal)], moreText: [l.bots, l.priority ? "Education Month priority level." : null].filter(Boolean) },
    {
      title: "Pick a seat (optional)",
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
        working("goal"), resultBox(res.goal),
      ],
      more: false,
      target: () => (!l.score.goal && !busy ? goalBtn : null),
      hint: noWorld ? "Build your world in Level 0 first." : "Press Run level.",
    },
    {
      title: l.score.shouldFail ? "Broken on purpose ✓" : "Now break it",
      body: [
        el("p", { class: "lead" }, l.shouldFail),
        el("div", { class: "act" }, failBtn = el("button", { class: "primary big", "data-pt": "run-fail", ...(busy || !state.world || l.score.shouldFail ? { disabled: true } : {}), on: { click: () => run("shouldFail") } }, "Try it (+5)")),
        working("shouldFail"), resultBox(res.shouldFail),
        l.score.shouldFail && l.rejectReason ? el("p", { class: "note" }, "Why it fails: " + l.rejectReason) : null,
      ],
      more: false,
      target: () => (!l.score.shouldFail && !busy ? failBtn : null),
      hint: "Press Try it. The ledger should refuse it.",
    },
  ];
  const pts = (l.score.goal ? 10 : 0) + (l.score.shouldFail ? 5 : 0) + (l.score.goal && l.score.shouldFail ? 5 : 0);
  const done = l.score.goal && l.score.shouldFail;
  cards.push(finishCard(l, done ? "Switch closed ✓" : "Almost there", done ? `Level ${l.n} complete: ${pts} of 20 points.` : `You have ${pts} of 20 points. Finish both steps to close this switch.`));
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
      title: `What is ${net}?`,
      body: [el("p", { class: "lead" }, `A public XRP Ledger test network. Its XRP is free and has no value.`), el("p", { class: "note" }, "It can be reset at any time, which wipes accounts.")],
      moreText: (l.explainer || []).map(fill),
    },
    {
      title: "Make your wallet",
      body: [
        el("p", { class: "lead" }, "Your browser makes a key pair. The secret (seed) never leaves this page."),
        el("div", { class: "act" }, genBtn = el("button", { class: "primary big", "data-pt": "gen", on: { click: () => { try { W.generateWallet(); l0.bal = null; l0.seedShown = false; l0.msg = ""; l0.worldMsg = ""; } catch (e) { l0.msg = e.message; } refresh().catch(() => render()); } } }, address ? "Make a new one" : "Generate wallet")),
        address ? el("p", {}, "Address: ", el("code", {}, address)) : null,
      ],
      more: false,
      target: () => (!address ? genBtn : null),
      hint: "Press Generate wallet.",
    },
    {
      title: "Save your seed",
      body: W.hasSeedInMemory() ? [
        el("div", { class: "warnbox" }, "Test-only. Never reuse a test seed on mainnet. Reloading this page forgets it."),
        el("div", { class: "act" }, el("code", { class: "seed" }, l0.seedShown ? W.revealSeed() : "•••••••••••••"),
          el("button", { on: { click: () => { l0.seedShown = !l0.seedShown; render(); } } }, l0.seedShown ? "Hide" : "Show")),
      ] : [el("p", { class: "lead" }, address ? "Your seed was only shown in the page where you made it, and isn't stored." : "Make a wallet first."), el("p", { class: "note" }, "You can still use the address for this game.")],
      more: false,
    },
    {
      title: "Fund it",
      body: [
        el("p", { class: "lead" }, "The faucet sends free test XRP, so your account exists on the ledger."),
        el("div", { class: "act" }, fundBtn = el("button", { class: "primary big", "data-pt": "fund", ...(address && !busy ? {} : { disabled: true }), on: { click: doFund } }, funded ? "Fund again" : "Fund from faucet"),
          el("button", { ...(address && !busy ? {} : { disabled: true }), on: { click: () => act("bal", async () => { try { l0.bal = await W.balance(); l0.msg = l0.bal.funded ? `Live: ${l0.bal.balanceXrp} test XRP.` : "Not funded yet."; } catch (e) { l0.msg = e.message; } }) } }, "Check balance")),
        busy === "fund" ? el("p", { class: "result" }, el("span", { class: "spinner", "aria-hidden": "true" }), l0.msg) : l0.msg ? el("p", { class: "result " + (funded ? "ok" : ""), role: "status" }, l0.msg) : null,
      ],
      more: false,
      target: () => (address && !funded && !busy ? fundBtn : null),
      hint: "Press Fund from faucet.",
    },
    state.world ? {
      title: mySeat?.wallet ? "Seat claimed ✓" : "Claim a seat",
      body: (() => {
        const kids = [el("p", { class: "lead" }, mySeat?.wallet ? `You play ${mySeat.role} with your wallet.` : "Your address replaces a bot in one seat of your world.")];
        const chips = seatChips(Object.keys(state.seats));
        firstSeat = chips.querySelector("button:not(:disabled):not(.mine)");
        kids.push(chips);
        return kids;
      })(),
      more: false,
      target: () => (mySeat?.wallet ? null : firstSeat),
      hint: "Pick a seat.",
    } : {
      title: "Build your world",
      body: [
        el("p", { class: "lead" }, "The server funds a fresh set of test accounts just for you, so your progress is yours alone."),
        el("div", { class: "act" }, worldBtn = el("button", { class: "primary big", "data-pt": "start-world", ...(address && !busy ? {} : { disabled: true }), on: { click: startMyWorld } }, "Start my world")),
        busy === "world" ? el("p", { class: "result", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), "Funding 6 test accounts from the faucet… about 30 seconds.") : null,
        l0.worldMsg ? el("p", { class: "result bad", role: "status" }, l0.worldMsg) : null,
        address ? null : el("p", { class: "note" }, "Make a wallet first: your world is keyed by its address."),
      ],
      more: false,
      target: () => (address && !busy ? worldBtn : null),
      hint: "Press Start my world.",
    },
    finishCard(l, walletDone() ? "Wallet ready ✓" : "Wallet step", walletDone() ? "Switch closed. Level 1 is next." : "Build your world and claim a seat with your wallet to close this switch."),
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

$("home").addEventListener("click", () => go("#/map"));
$("nav-map").addEventListener("click", () => go("#/map"));
$("nav-tools").addEventListener("click", () => go("#/tools"));
addEventListener("hashchange", () => { render(); $("screen").focus({ preventScroll: true }); });
refresh().catch((e) => { $("screen").replaceChildren(el("p", { class: "result bad" }, "Server not reachable: " + e.message)); });
