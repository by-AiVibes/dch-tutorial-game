// Lesson guides: the two picture cards, the level -> video manifest, and the per-world choice.
// Loaded only when the page was served with the guide picker flag on (see src/guides.ts).
// Pure functions: the page passes in localStorage, tests pass in a fake.

export const GUIDES = [
  { id: "a", name: "Guide A", blurb: "A friendly person talks you through each level.", img: "/guides/guide-a.jpg", alt: "Guide A: a smiling person with blue hair in a circuit-pattern hoodie" },
  { id: "b", name: "Guide B", blurb: "A friendly robot talks you through each level.", img: "/guides/guide-b.jpg", alt: "Guide B: a smiling robot waving hello" },
];
export const GUIDE_IDS = GUIDES.map((g) => g.id);
export const isGuide = (id) => GUIDE_IDS.includes(id);

/**
 * Level id -> guide id -> file name under the video base URL. The wallet level (Level 0) reuses the
 * first lesson files, and its guide B file is the re-recorded one (-v2).
 */
export const LESSON_VIDEOS = {
  wallet: { a: "level1-guide-a.mp4", b: "level1-guide-b-v2.mp4" },
  issue: { a: "issue-guide-a.mp4", b: "issue-guide-b.mp4" },
  freeze: { a: "freeze-guide-a.mp4", b: "freeze-guide-b.mp4" },
  creds: { a: "creds-guide-a.mp4", b: "creds-guide-b.mp4" },
  domain: { a: "domain-guide-a.mp4", b: "domain-guide-b.mp4" },
  batch: { a: "batch-guide-a.mp4", b: "batch-guide-b.mp4" },
  vault: { a: "vault-guide-a.mp4", b: "vault-guide-b.mp4" },
  lend: { a: "lend-guide-a.mp4", b: "lend-guide-b.mp4" },
  confidential: { a: "confidential-guide-a.mp4", b: "confidential-guide-b.mp4" },
};

/** File name for a level and guide, or null (unknown level, unknown guide). */
export const lessonFile = (level, guide) => (Object.hasOwn(LESSON_VIDEOS, level) && isGuide(guide) ? LESSON_VIDEOS[level][guide] : null);

/** Full URL: the configured base (a path or an https URL) plus the file name. */
export function videoUrl(base, level, guide) {
  const f = lessonFile(level, guide);
  if (!f) return null;
  const b = String(base || "/lesson-videos/");
  return (b.endsWith("/") ? b : b + "/") + f;
}

/** The server's config, read from <meta name="dch-guides">. Null when the flag is off. */
export function readGuideConfig(doc) {
  const m = doc?.querySelector?.('meta[name="dch-guides"]');
  if (!m) return null;
  try {
    const c = JSON.parse(m.getAttribute("content") || "");
    return c && typeof c.videoBase === "string" ? { videoBase: c.videoBase } : null;
  } catch { return null; }
}

// ---- the choice, kept per world (the world is the wallet address, as for the rest of the game) ----
export const STORE_PREFIX = "dch-guide-v1:";
/** Before a wallet exists there is no world yet: the pick waits here and moves to the first world that asks. */
export const PENDING = "pending";
const memory = new Map(); // fallback when localStorage is unavailable (private mode): lasts for this page only
export const storeKey = (world) => STORE_PREFIX + (world || PENDING);

function readRaw(storage, key) {
  let raw = null;
  try { raw = storage.getItem(key); } catch { raw = memory.get(key) ?? null; }
  if (raw == null) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || !isGuide(j.guide)) return null;
    return { guide: j.guide, seen: Array.isArray(j.seen) ? j.seen.filter((x) => typeof x === "string").slice(0, 64) : [] };
  } catch { return null; }
}
function writeRaw(storage, key, rec) {
  const raw = JSON.stringify(rec);
  try { storage.setItem(key, raw); } catch { memory.set(key, raw); }
}
function dropRaw(storage, key) {
  try { storage.removeItem(key); } catch { memory.delete(key); }
}

/** { guide, seen } for this world, or null when it has not picked yet. */
export function loadGuide(storage, world) {
  const own = readRaw(storage, storeKey(world));
  if (own || !world) return own;
  const pending = readRaw(storage, storeKey(""));
  if (!pending) return null;
  writeRaw(storage, storeKey(world), pending); // the pick made before the wallet existed becomes this world's
  dropRaw(storage, storeKey(""));
  return pending;
}
export function saveGuide(storage, world, guide) {
  if (!isGuide(guide)) throw new Error("unknown guide");
  const cur = readRaw(storage, storeKey(world)) || readRaw(storage, storeKey("")) || { seen: [] };
  const rec = { guide, seen: cur.seen };
  writeRaw(storage, storeKey(world), rec);
  if (world) dropRaw(storage, storeKey(""));
  return rec;
}
const seenKey = (level, guide) => `${level}:${guide}`;
export function hasSeen(rec, level) { return !!rec && rec.seen.includes(seenKey(level, rec.guide)); }
export function markSeen(storage, world, level) {
  const rec = loadGuide(storage, world);
  if (!rec || !lessonFile(level, rec.guide)) return rec;
  const k = seenKey(level, rec.guide);
  if (!rec.seen.includes(k)) { rec.seen.push(k); writeRaw(storage, storeKey(world), rec); }
  return rec;
}
