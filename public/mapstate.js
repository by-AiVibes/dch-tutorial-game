// Circuit-map state: pure functions (no DOM), shared by the browser and the tests.
// A level's switch is "closed" when the level is complete; traces light from the power
// source up to the first open switch. Levels whose amendment is off on this network are
// "soon" and bypassed, so they never block the circuit.

/** Short labels for the map nodes. */
export const SHORT = {
  wallet: "Wallet", issue: "Token", freeze: "Freeze", creds: "Credential", domain: "Domain",
  batch: "Batch", vault: "Vault", lend: "Loan", confidential: "Confidential",
};

/** Kind of level: onboarding (Level 0), scored (goal + should-fail), or explainer (read-only). */
export function levelKind(l) {
  if (l.n === 0) return "onboarding";
  return l.goalRoles && l.goalRoles.length ? "scored" : "explainer";
}

/**
 * Is this level complete?
 * ctx.walletDone: Level 0 finished (player claimed a seat with a wallet).
 * ctx.read: ids of explainer levels the player read to the end.
 */
export function levelDone(l, ctx = {}) {
  const kind = levelKind(l);
  if (kind === "onboarding") return !!ctx.walletDone;
  if (kind === "explainer") return !!ctx.read && new Set(ctx.read).has(l.id);
  return !!(l.score && l.score.goal && l.score.shouldFail);
}

/**
 * Build the map: one node per level with a status, the traces between them, and the
 * current level.
 *   status: "done" | "current" | "locked" | "soon"
 *   node.closed: switch closed (level done)
 *   node.partial: scored level with one of its two parts done
 *   traces[i]: from node i-1 (or the power source when i = 0) to node i; lit when power
 *     reaches node i. traces[levels.length] runs from the last node to the lamp.
 */
export function mapState(levels, ctx = {}) {
  const sorted = [...levels].sort((a, b) => a.n - b.n);
  let current = null;
  const nodes = sorted.map((l) => {
    const closed = l.available !== false && levelDone(l, ctx);
    const partial = levelKind(l) === "scored" && !closed && !!(l.score && (l.score.goal || l.score.shouldFail));
    let status;
    if (l.available === false) status = "soon";
    else if (closed) status = "done";
    else if (current === null) { status = "current"; current = l.id; }
    else status = "locked";
    return { id: l.id, n: l.n, title: l.title, short: SHORT[l.id] || l.title, status, closed, partial };
  });
  // Power flows from the source through each closed (or bypassed) switch, and stops at the first open one.
  const traces = [];
  let powered = true;
  for (const node of nodes) {
    traces.push({ to: node.id, lit: powered });
    if (!(node.status === "done" || node.status === "soon")) powered = false;
  }
  const playable = nodes.filter((x) => x.status !== "soon");
  const doneCount = playable.filter((x) => x.status === "done").length;
  const allComplete = playable.length > 0 && doneCount === playable.length;
  traces.push({ to: "lamp", lit: allComplete });
  return { nodes, traces, current, allComplete, doneCount, total: playable.length };
}

/**
 * Serpentine layout for the circuit. Slot -1 is the power source (above node 0) and slot
 * `count` is the lamp. Returns { w, h, pos(slot) -> {x, y} }.
 */
export function layout(count, cols) {
  const w = cols >= 3 ? 900 : 360;
  const mx = cols >= 3 ? 150 : 90;
  const dy = cols >= 3 ? 150 : 128;
  const top = cols >= 3 ? 150 : 140;
  const pos = (slot) => {
    if (slot < 0) return { x: mx, y: top - 100 };
    const row = Math.floor(slot / cols);
    const i = slot % cols;
    const col = row % 2 === 0 ? i : cols - 1 - i;
    const x = cols === 1 ? w / 2 : mx + (col * (w - 2 * mx)) / (cols - 1);
    return { x, y: top + row * dy };
  };
  const rows = Math.floor(count / cols) + 1;
  return { w, h: top + (rows - 1) * dy + 80, pos };
}

/** Orthogonal circuit-trace path between two points. */
export function tracePath(a, b) {
  if (a.x === b.x || a.y === b.y) return `M${a.x} ${a.y} L${b.x} ${b.y}`;
  const mid = (a.y + b.y) / 2;
  return `M${a.x} ${a.y} V${mid} H${b.x} V${b.y}`;
}

/**
 * Ring layout: level switches on a circle around a central chip, Level 0 at the top, going
 * clockwise. Returns { w, h, cx, cy, r, pos(i) -> {x, y, a}, label(i) -> {x, y, anchor},
 * badge(i) -> {x, y} } (badge = the level-number tag on the pad's outer edge).
 */
export function ringLayout(count, size = 440) {
  const cx = size / 2, cy = size / 2, r = size * 0.245;
  const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / count;
  const pos = (i) => ({ x: cx + r * Math.cos(ang(i)), y: cy + r * Math.sin(ang(i)), a: ang(i) });
  const label = (i) => {
    const c = Math.cos(ang(i)), s = Math.sin(ang(i));
    const lr = r + size * 0.1;
    return { x: cx + lr * c, y: cy + lr * s + 5, anchor: c > 0.3 ? "start" : c < -0.3 ? "end" : "middle" };
  };
  const badge = (i) => ({ x: cx + (r + 24) * Math.cos(ang(i)), y: cy + (r + 24) * Math.sin(ang(i)) });
  return { w: size, h: size, cx, cy, r, pos, label, badge };
}

/** SVG arc along the ring from node i to node j (clockwise). */
export function ringArc(L, i, j) {
  const a = L.pos(i), b = L.pos(j);
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} A${L.r} ${L.r} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}
