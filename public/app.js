// Minimal dashboard. Uses textContent everywhere (no innerHTML with data).
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : String(k));
  return e;
};
let state = null, selected = "issue", lastMsg = "", busy = false;
const playerInput = $("player");
playerInput.value = localStorage.getItem("dch-player") || "";
playerInput.addEventListener("change", () => { localStorage.setItem("dch-player", playerInput.value.trim()); render(); });
const me = () => playerInput.value.trim() || null;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function refresh() { state = await api("/api/state"); render(); }
async function act(fn) {
  if (busy) return; busy = true; lastMsg = "Working… (ledger steps take a few seconds each)"; render();
  try { await fn(); } catch (e) { lastMsg = "Error: " + e.message; }
  busy = false; await refresh();
}

function render() {
  if (!state) return;
  const s = state;
  $("stats").replaceChildren(
    ...[["Network", s.network], ["World", s.world || "none yet"], ["Score", `${s.score} / ${s.maxScore}`],
        ["Your seat", Object.values(s.seats).find((x) => x.player && x.player === me())?.role || "none"]]
      .map(([k, v]) => el("div", { class: "stat" }, k, el("b", {}, v))));
  $("seats").replaceChildren(...Object.values(s.seats).map((seat) => {
    const mine = seat.player && seat.player === me();
    return el("div", { class: "seat" },
      el("b", {}, seat.role), el("br"),
      el("span", { class: "tag" + (seat.player ? " ok" : "") }, seat.player ? `human: ${seat.player}` : "bot"),
      el("br"), s.accounts[seat.role] ? el("small", {}, s.accounts[seat.role].address.slice(0, 10) + "…") : null, el("br"),
      mine ? el("button", { on: { click: () => act(() => api("/api/seat/release", { role: seat.role, player: me() })) } }, "Leave seat")
           : el("button", { ...(seat.player || !me() ? { disabled: "" } : {}), on: { click: () => act(() => api("/api/seat/claim", { role: seat.role, player: me() })) } }, "Claim"));
  }));
  $("levels").replaceChildren(...s.levels.map((l) => el("div", { class: "lvl" + (l.id === selected ? " sel" : ""), on: { click: () => { selected = l.id; lastMsg = ""; render(); } } },
    el("b", {}, `${l.n}. ${l.title}`), el("br"),
    l.available ? el("span", { class: "tag ok" }, l.playable ? "playable" : "next slice") : el("span", { class: "tag warn" }, "coming soon"),
    l.priority ? el("span", { class: "tag pri" }, "priority") : null,
    l.n <= 7 ? el("span", { class: "tag" }, `${(l.score.goal ? 10 : 0) + (l.score.shouldFail ? 5 : 0) + (l.score.goal && l.score.shouldFail ? 5 : 0)} pts`) : null)));
  const l = s.levels.find((x) => x.id === selected);
  const disabled = busy || !l.playable || !s.world ? { disabled: "" } : {};
  $("detail").replaceChildren(
    el("h2", {}, `Level ${l.n}: ${l.title}`),
    !l.available ? el("p", { class: "msg" }, `Coming soon: ${l.feature} is not enabled on ${s.network} yet. The game checks this live; it never assumes.`) : null,
    l.explainer ? el("ul", {}, l.explainer.map((t) => el("li", {}, t))) : null,
    el("p", {}, el("b", {}, "Goal: "), l.goal, l.goalRoles.length ? ` (seats: ${l.goalRoles.join(", ")})` : ""),
    el("p", {}, el("b", {}, "Should fail: "), l.shouldFail),
    l.rejectReason ? el("p", {}, el("b", {}, "Why it fails: "), l.rejectReason) : null,
    el("p", {}, el("b", {}, "Bots: "), l.bots),
    l.goalRoles.length ? el("p", {},
      el("button", { ...disabled, on: { click: () => act(async () => { const r = await api(`/api/levels/${l.id}/goal`, { player: me() }); lastMsg = `${r.message}${r.added ? ` (+${r.added})` : ""}`; }) } }, "Run goal (+10)"), " ",
      el("button", { ...disabled, on: { click: () => act(async () => { const r = await api(`/api/levels/${l.id}/should-fail`, { player: me() }); lastMsg = `${r.message}${r.added ? ` (+${r.added})` : ""}`; }) } }, "Try the should-fail (+5)")) : null,
    el("p", {}, "Learn more: ", ...l.docs.flatMap((d, i) => [i ? " · " : "", el("a", { href: d.href, target: "_blank", rel: "noopener" }, d.title)])),
    lastMsg ? el("div", { class: "msg" }, lastMsg) : null);
  const a = s.amendments;
  $("amend").replaceChildren(a ? el("table", {}, el("tr", {}, el("th", {}, "Amendment"), el("th", {}, `Status on ${a.network}`)),
    Object.values(a.amendments).map((x) => el("tr", {}, el("td", {}, x.name), el("td", { class: x.enabled ? "res-tes" : "res-bad" }, x.enabled ? "enabled" : x.known ? "not enabled (may be in voting)" : "unknown to this server"))),
    el("tr", {}, el("td", {}, "checked"), el("td", {}, new Date(a.checkedAt).toLocaleString()))) : el("p", {}, "Not checked yet."));
  $("recent").replaceChildren(s.recent.length ? el("table", {}, el("tr", {}, ...["Level", "Type", "By", "Result", "Tx"].map((h) => el("th", {}, h))),
    s.recent.map((r) => el("tr", {}, el("td", {}, `${r.level} ${r.part}`), el("td", {}, r.type), el("td", {}, r.note || ""),
      el("td", { class: r.engineResult.startsWith("tes") ? "res-tes" : "res-bad" }, r.engineResult),
      el("td", {}, el("a", { href: s.explorer + r.hash, target: "_blank", rel: "noopener" }, r.hash.slice(0, 12) + "…"))))) : el("p", {}, "No transactions in this world yet."));
  $("bugs").replaceChildren(...s.bugs.map((b) => el("p", { class: "msg" }, "Flagged: " + b)));
}
$("check").addEventListener("click", () => act(() => api("/api/amendments", {})));
$("reset").addEventListener("click", () => act(async () => { await api("/api/reset-world", {}); lastMsg = "New world ready."; }));
refresh().catch((e) => { document.body.prepend(el("p", { class: "msg" }, "Server not reachable: " + e.message)); });
