// Graduation award: a shareable card (SVG -> PNG on the server) for players whose own world
// really has every level complete. Each award has a random id, so share links never carry the
// player's address. No seeds, no full addresses, no wallet app names on the card.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { DATA_DIR } from "./config.ts";

/** 1200x675 (16:9): X shows summary_large_image cards at about 1.91:1-16:9, so nothing is cropped. */
export const CARD_W = 1200;
export const CARD_H = 675;
export const MAX_PNG_BYTES = 1_500_000;
export const NAME_MAX = 32;
export const AWARD_ID_RE = /^[A-Za-z0-9_-]{24}$/;
const URL_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/;

/** DCH_PUBLIC_URL (e.g. https://game.example.org), or null when unset or invalid. */
export function configuredUrl(): string | null {
  const u = (process.env.DCH_PUBLIC_URL || "").trim().replace(/\/$/, "");
  return URL_RE.test(u) ? u : null;
}

/** The configured public host (for the card footer), or null. */
export const configuredHost = () => configuredUrl()?.replace(/^https?:\/\//, "") ?? null;

/**
 * Base URL for absolute share links: DCH_PUBLIC_URL, else the request Host, but only behind a
 * trusted proxy and only if the host is listed in DCH_PUBLIC_HOSTS. Otherwise null (no absolute URLs).
 */
export function publicBase(hostHeader: string | undefined, trustProxy: boolean): string | null {
  const c = configuredUrl();
  if (c) return c;
  if (!trustProxy || !hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  const allow = (process.env.DCH_PUBLIC_HOSTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return HOST_RE.test(h) && allow.includes(h) ? `https://${h}` : null;
}
const FONTS = [join(import.meta.dirname, "..", "assets", "fonts", "DejaVuSans.ttf"), join(import.meta.dirname, "..", "assets", "fonts", "DejaVuSans-Bold.ttf")];

/** Short level names for the card (same labels as the in-game map). */
export const SHORT: Record<string, string> = {
  wallet: "Wallet", issue: "Token", freeze: "Freeze", creds: "Credential", domain: "Domain",
  batch: "Batch", vault: "Vault", lend: "Loan", confidential: "Confidential",
};

export interface AwardLevel { n: number; short: string }
/** levels = exactly the levels the server required and verified for this award. */
export interface AwardRecord {
  id: string;
  network: string;
  name: string;
  score: number;
  maxScore: number;
  /** UTC date the circuit was first completed (YYYY-MM-DD). */
  date: string;
  levels: AwardLevel[];
}

export const newAwardId = () => randomBytes(18).toString("base64url"); // 144 random bits, 24 chars

/** Escape for SVG/HTML text and attribute values. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A display name: printable text only, at most NAME_MAX characters, never an address. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Enter a display name.");
  const s = raw.normalize("NFC").replace(/[\p{C}]/gu, "").replace(/\s+/g, " ").trim();
  if (!s) throw new Error("Enter a display name.");
  if ([...s].length > NAME_MAX) throw new Error(`Keep your name to ${NAME_MAX} characters.`);
  if (/r[1-9A-HJ-NP-Za-km-z]{24,34}/.test(s)) throw new Error("Use a display name, not an address.");
  return s;
}

export const awardsDir = () => join(DATA_DIR, "awards");
const recPath = (id: string) => {
  if (!AWARD_ID_RE.test(id)) throw new Error("bad award id");
  return join(awardsDir(), `${id}.json`);
};
const pngPath = (id: string) => recPath(id).replace(/\.json$/, ".png");

export function awardCount(): number {
  return existsSync(awardsDir()) ? readdirSync(awardsDir()).filter((f) => f.endsWith(".json")).length : 0;
}

export function loadAward(id: string): AwardRecord | null {
  if (!AWARD_ID_RE.test(id)) return null;
  try {
    return JSON.parse(readFileSync(recPath(id), "utf8")) as AwardRecord;
  } catch {
    return null;
  }
}

export function saveAward(rec: AwardRecord): void {
  mkdirSync(awardsDir(), { recursive: true, mode: 0o700 });
  const p = recPath(rec.id);
  writeFileSync(`${p}.tmp`, JSON.stringify(rec, null, 2), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  try { unlinkSync(pngPath(rec.id)); } catch { /* no cached image yet */ }
}

const fmtDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
};

/** The fully lit ring board (our own design, same look as the in-game map) at (ox, oy), size S. */
function board(ox: number, oy: number, S: number, levels: AwardLevel[]): string {
  const N = levels.length, cx = ox + S / 2, cy = oy + S / 2, r = S * 0.3;
  const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
  const P = (i: number, rr = r) => [cx + rr * Math.cos(ang(i)), cy + rr * Math.sin(ang(i))];
  const f = (n: number) => n.toFixed(1);
  const out: string[] = [];
  out.push(`<rect x="${ox}" y="${oy}" width="${S}" height="${S}" rx="30" fill="#0d4a32" stroke="#c8a052" stroke-width="4"/>`);
  out.push(`<rect x="${ox}" y="${oy}" width="${S}" height="${S}" rx="30" fill="url(#vias)"/>`);
  for (const [x, y] of [[ox + 26, oy + 26], [ox + S - 26, oy + 26], [ox + 26, oy + S - 26], [ox + S - 26, oy + S - 26]]) out.push(`<circle cx="${x}" cy="${y}" r="9" fill="#0a3826" stroke="#c8a052" stroke-width="3"/>`);
  // decorative side traces to the board edge
  for (let i = 0; i < N; i++) {
    const [x1, y1] = P(i, r + 34), [x2, y2] = P(i, r + 62);
    out.push(`<path d="M${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)}" stroke="#2f7d58" stroke-width="3" stroke-linecap="round"/><circle cx="${f(x2)}" cy="${f(y2)}" r="4" fill="#c8a052"/>`);
  }
  out.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.9}" fill="url(#halo)"/>`);
  const lit = `stroke="#ffd34d" filter="url(#glow)"`;
  for (let i = 0; i < N; i++) {
    const [x, y] = P(i), [sx, sy] = P(i, r * 0.42);
    out.push(`<path d="M${f(sx)} ${f(sy)} L${f(x)} ${f(y)}" ${lit} stroke-width="5" stroke-linecap="round"/>`);
  }
  out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" ${lit} stroke-width="12"/>`);
  out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff6c9" stroke-width="3" stroke-dasharray="8 16" opacity="0.85"/>`);
  // core chip, powered
  const cs = S * 0.25, x0 = cx - cs / 2, y0 = cy - cs / 2;
  for (let k = 0; k < 6; k++) {
    const o = cs * 0.12 + (k * cs * 0.76) / 5 - 4;
    out.push(`<rect x="${f(x0 + o)}" y="${f(y0 - 12)}" width="8" height="12" fill="#c8a052"/><rect x="${f(x0 + o)}" y="${f(y0 + cs)}" width="8" height="12" fill="#c8a052"/>`);
    out.push(`<rect x="${f(x0 - 12)}" y="${f(y0 + o)}" width="12" height="8" fill="#c8a052"/><rect x="${f(x0 + cs)}" y="${f(y0 + o)}" width="12" height="8" fill="#c8a052"/>`);
  }
  out.push(`<rect x="${f(x0)}" y="${f(y0)}" width="${f(cs)}" height="${f(cs)}" rx="12" fill="#2b2510" stroke="#ffd34d" stroke-width="4" filter="url(#glow)"/>`);
  out.push(`<circle cx="${f(x0 + 18)}" cy="${f(y0 + 18)}" r="5" fill="#3fb950"/>`);
  out.push(`<text x="${cx}" y="${f(cy - 16)}" text-anchor="middle" font-size="15" font-weight="bold" letter-spacing="2" fill="#ffd34d">CORE</text>`);
  out.push(`<text x="${cx}" y="${f(cy + 18)}" text-anchor="middle" font-size="32" font-weight="bold" fill="#fff6c9">${N}/${N}</text>`);
  out.push(`<text x="${cx}" y="${f(cy + 40)}" text-anchor="middle" font-size="13" font-weight="bold" letter-spacing="2" fill="#ffd34d">POWERED</text>`);
  // closed switches
  for (let i = 0; i < N; i++) {
    const [x, y] = P(i), deg = (ang(i) * 180) / Math.PI + 90;
    out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="30" fill="#ffd34d" stroke="#fff6c9" stroke-width="3" filter="url(#glow)"/>`);
    out.push(`<g transform="translate(${f(x)} ${f(y)}) rotate(${f(deg)})"><circle cx="-13" cy="0" r="4.5" fill="#2a2110"/><circle cx="13" cy="0" r="4.5" fill="#2a2110"/><line x1="-13" y1="0" x2="13" y2="0" stroke="#2a2110" stroke-width="5" stroke-linecap="round"/></g>`);
    const [bx, by] = P(i, r + 30);
    out.push(`<circle cx="${f(bx)}" cy="${f(by)}" r="11" fill="#15181e" stroke="#ffd34d" stroke-width="2"/><text x="${f(bx)}" y="${f(by + 4.5)}" text-anchor="middle" font-size="13" font-weight="bold" fill="#ffd34d">${levels[i].n}</text>`);
  }
  return out.join("");
}

/** Largest font size (<= max) at which the bold name fits in `width` px, measured with the bundled font. */
function fitSize(escaped: string, width: number, max: number): number {
  const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200"><text x="0" y="100" font-family="DejaVu Sans" font-size="100" font-weight="bold">${escaped}</text></svg>`;
  const bb = new Resvg(probe, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" } }).getBBox();
  const w100 = bb?.width || 1;
  return Math.max(12, Math.min(max, Math.floor((width * 100) / w100)));
}

/** The award card as SVG. Every piece of player text is escaped. */
export function awardSvg(rec: AwardRecord, host: string | null = configuredHost()): string {
  const name = esc(rec.name);
  const nameSize = fitSize(name, 480, 52);
  const X = 680;
  const half = Math.ceil(rec.levels.length / 2);
  const rows = rec.levels.map((l, i) => {
    const col = i < half ? 0 : 1, row = i < half ? i : i - half;
    const x = X + col * 245, y = 388 + row * 38;
    return `<circle cx="${x + 13}" cy="${y - 7}" r="13" fill="#123d2b" stroke="#3fb950" stroke-width="2"/><path d="M${x + 6} ${y - 7} l5 5 l9 -10" fill="none" stroke="#3fb950" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><text x="${x + 36}" y="${y}" font-size="20" fill="#e7f5ec"><tspan fill="#c8a052" font-weight="bold">${String(l.n).padStart(2, "0")}</tspan>  ${esc(l.short)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" font-family="DejaVu Sans">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c1a14"/><stop offset="1" stop-color="#0f1115"/></linearGradient>
<pattern id="vias" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1.6" fill="#1d6b4a"/></pattern>
<radialGradient id="halo"><stop offset="0" stop-color="#fff6c9" stop-opacity="0.55"/><stop offset="1" stop-color="#ffd34d" stop-opacity="0"/></radialGradient>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="${CARD_W}" height="${CARD_H}" fill="url(#bg)"/>
<rect x="10" y="10" width="${CARD_W - 20}" height="${CARD_H - 20}" rx="26" fill="none" stroke="#c8a052" stroke-width="2" opacity="0.6"/>
${board(40, 37, 600, rec.levels)}
<text x="${X}" y="78" font-size="17" font-weight="bold" letter-spacing="2" fill="#7ee2a8">#XRPEducationMonth</text>
<text x="1160" y="78" text-anchor="end" font-size="17" fill="#9aa3b2">${esc(fmtDate(rec.date))} UTC</text>
<rect x="${X}" y="100" width="480" height="74" rx="14" fill="#2b2510" stroke="#ffd34d" stroke-width="3"/>
<text x="${X + 240}" y="148" text-anchor="middle" font-size="36" font-weight="bold" letter-spacing="5" fill="#ffd34d">GRADUATE</text>
<text x="${X}" y="${nameSize > 40 ? 250 : 244}" font-size="${nameSize}" font-weight="bold" fill="#ffffff">${name}</text>
<text x="${X}" y="292" font-size="19" fill="#9aa3b2">has completed the XRPL Amendments Tutorial on XRPL ${esc(rec.network)}</text>
<text x="${X}" y="330" font-size="24" font-weight="bold" letter-spacing="3" fill="#ffd34d">CIRCUIT COMPLETE ⚡</text>
${rows}
<rect x="${X + 245}" y="535" width="235" height="42" rx="21" fill="#2b2510" stroke="#ffd34d" stroke-width="2"/>
<text x="${X + 362}" y="563" text-anchor="middle" font-size="20" font-weight="bold" fill="#ffd34d">SCORE ${rec.score}/${rec.maxScore}</text>
${host ? `<rect x="${X}" y="595" width="480" height="48" rx="12" fill="#e7f5ec"/>
<text x="${X + 18}" y="626" font-size="13" font-weight="bold" letter-spacing="1" fill="#1d6b4a">GET YOUR CARD →</text>
<text x="1142" y="627" text-anchor="end" font-size="18" font-weight="bold" fill="#0d1a14">${esc(host)}</text>` : ""}
</svg>`;
}

export function renderPng(svg: string): Buffer {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_W },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" },
  }).render().asPng();
  if (png.length > MAX_PNG_BYTES) throw new Error("award image too large");
  return png;
}

/** The PNG for an award, rendered once and cached on disk next to the record. */
export function awardPng(rec: AwardRecord): Buffer {
  const p = pngPath(rec.id);
  try {
    return readFileSync(p);
  } catch { /* render below */ }
  const png = renderPng(awardSvg(rec));
  mkdirSync(awardsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(`${p}.tmp`, png, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  return png;
}

/** The share page: Open Graph + Twitter tags so the link previews with the card on X. */
export function awardHtml(rec: AwardRecord, base: string | null): string {
  const title = `${rec.name}: Graduate, circuit complete`;
  const desc = `Completed all ${rec.levels.length} required levels of the XRPL Amendments Tutorial on XRPL ${rec.network}. Score ${rec.score}/${rec.maxScore}. #XRPEducationMonth`;
  const page = base ? `${base}/award/${rec.id}` : null, img = page ? `${page}.png` : null;
  // Without a known public base, absolute og:url / og:image are omitted rather than guessed.
  const abs = page && img ? `
<meta property="og:url" content="${esc(page)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="${CARD_W}">
<meta property="og:image:height" content="${CARD_H}">
<meta property="og:image:alt" content="${esc(`Graduate card for ${rec.name}: a fully lit circuit board ring with the core powered, ${rec.score}/${rec.maxScore}`)}">
<meta name="twitter:image" content="${esc(img)}">` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">${abs}
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/award.css">
</head><body>
<main class="award-page">
<img src="/award/${esc(rec.id)}.png" width="${CARD_W}" height="${CARD_H}" alt="${esc(`Graduate card for ${rec.name}`)}">
<p>${esc(rec.name)} powered the full circuit: all ${rec.levels.length} required levels of hands-on XRPL development on ${esc(rec.network)}.</p>
<p><a class="cta" href="/">Play the XRPL Amendments Tutorial and get your card</a></p>
<p class="small">Test networks only, no real funds. Facts link to <a href="https://xrpl.org">xrpl.org</a>.</p>
</main>
</body></html>`;
}
