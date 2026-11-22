/**
 * Lifetime and per-day (UTC) counters for visitors and players, kept in <data dir>/stats.json,
 * apart from the world files, so evicting idle worlds never loses history.
 *
 * Privacy: no IP address, wallet address or user agent is ever written. A unique visitor is an
 * HMAC-SHA256 of the IP under a random key that lives only in memory and is replaced every UTC
 * day; the set of today's hashes is in memory too. Only the per-day count reaches the disk, so
 * visitors can't be linked across days or recovered from the file. (After a server restart the
 * key is new, so someone who returns later that same day may be counted twice.)
 *
 * Player events (world started, level steps done, quiz passed, first-try quiz points, graduated)
 * are counted once per world: each world records which events it already counted
 * (WorldState.statsCounted). Worlds started by testers (DCH_STATS_IGNORE_IPS, or a user agent
 * containing a DCH_STATS_IGNORE_UA marker such as the e2e's "DCH-e2e") are never counted.
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DayStats {
  /** Unique visitors that day (daily-rotated HMAC of the IP; not unique across days). */
  visitors: number;
  /** Game page loads (GET / or /index.html). */
  pageViews: number;
  /** Share-page loads (GET /award/<id>), e.g. people opening a shared card. */
  awardViews: number;
  worldsStarted: number;
  /** Level steps done, per level id (Level 0: wallet seat linked; 1-7: goal and should-fail). */
  levelsCompleted: Record<string, number>;
  /** Quizzes passed (the switch closed), per level id. */
  quizzesPassed: Record<string, number>;
  graduates: number;
  /** First-try quiz points: sum and number of first attempts, per level id (max 30 each). */
  quizFirstTry: Record<string, { points: number; attempts: number }>;
}

export interface StatsFile {
  version: 1;
  network: string;
  createdAt: string;
  backfill: { at: string; worlds: number; awards: number } | null;
  lifetime: DayStats;
  days: Record<string, DayStats>;
}

export type StatEvent =
  | { type: "world" }
  | { type: "level"; id: string }
  | { type: "quiz"; id: string }
  | { type: "quizFirst"; id: string; points: number }
  | { type: "grad" };

/** A world as far as stats care (structurally a WorldState). */
export interface Countable { statsCounted?: string[]; statsIgnore?: boolean }

export const emptyDay = (): DayStats => ({ visitors: 0, pageViews: 0, awardViews: 0, worldsStarted: 0, levelsCompleted: {}, quizzesPassed: {}, graduates: 0, quizFirstTry: {} });

const eventKey = (e: StatEvent) => (e.type === "world" || e.type === "grad" ? e.type : `${e.type}:${e.id}`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const MAX_HASHES = 200_000; // beyond this many visitors a day, new ones are still counted (approximate)

function bump(d: DayStats, e: StatEvent) {
  switch (e.type) {
    case "world": d.worldsStarted++; break;
    case "level": d.levelsCompleted[e.id] = (d.levelsCompleted[e.id] ?? 0) + 1; break;
    case "quiz": d.quizzesPassed[e.id] = (d.quizzesPassed[e.id] ?? 0) + 1; break;
    case "quizFirst": { const q = (d.quizFirstTry[e.id] ??= { points: 0, attempts: 0 }); q.points += e.points; q.attempts++; break; }
    case "grad": d.graduates++; break;
  }
}

/** Parse an ignore list: exact IPs (v4 or v6) and IPv4 CIDRs like 203.0.113.0/24. */
export function parseIgnoreIps(s: string | undefined): (ip: string) => boolean {
  const exact = new Set<string>(), nets: [number, number][] = [];
  const v4 = (ip: string) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip); return m ? m.slice(1).reduce((a, x) => (a << 8) + Number(x), 0) >>> 0 : null; };
  for (const raw of (s || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [ip, bits] = raw.split("/");
    const n = v4(ip);
    if (bits !== undefined && n !== null && Number(bits) >= 0 && Number(bits) <= 32) {
      const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      nets.push([(n & mask) >>> 0, mask]);
    } else exact.add(raw.toLowerCase());
  }
  return (ip: string) => {
    const clean = ip.replace(/^::ffff:/, "").toLowerCase();
    if (exact.has(clean)) return true;
    const n = v4(clean);
    return n !== null && nets.some(([net, mask]) => ((n & mask) >>> 0) === net);
  };
}

export interface StatsOptions {
  network: string;
  now?: () => number;
  ignoreIps?: string;
  /** Comma-separated user-agent substrings that mark testers. Default "DCH-e2e". */
  ignoreUa?: string;
  /** Write at most this often (ms); 0 writes on every change (tests). */
  flushMs?: number;
  /** One short line on a failed save or a quarantined file (never paths or values). */
  log?: (msg: string) => void;
}

export class Stats {
  readonly path: string;
  data: StatsFile;
  private readonly now: () => number;
  private readonly ipIgnored: (ip: string) => boolean;
  private readonly uaMarks: string[];
  private readonly flushMs: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly log: (msg: string) => void;
  private failing = false;
  // Today's visitor key and hashes: memory only, replaced every UTC day.
  private visitorDay = "";
  private visitorKey: Buffer = randomBytes(32);
  private seen = new Set<string>();

  constructor(path: string, opts: StatsOptions) {
    this.path = path;
    this.now = opts.now ?? Date.now;
    this.ipIgnored = parseIgnoreIps(opts.ignoreIps);
    this.uaMarks = (opts.ignoreUa ?? "DCH-e2e").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    this.flushMs = opts.flushMs ?? 5000;
    this.log = opts.log ?? ((m) => console.error(m));
    this.data = this.loadOrQuarantine() ?? { version: 1, network: opts.network, createdAt: new Date(this.now()).toISOString(), backfill: null, lifetime: emptyDay(), days: {} };
  }

  /**
   * Load the file; if it exists but can't be parsed, move it aside to
   * stats.json.corrupt-<UTC date-time> (kept for a look) and start empty, never overwrite it.
   */
  private loadOrQuarantine(): StatsFile | null {
    const ok = Stats.read(this.path);
    if (ok || !existsSync(this.path)) return ok;
    try {
      renameSync(this.path, `${this.path}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`);
      this.log("stats: the stats file was unreadable; moved it aside and started fresh");
    } catch {
      this.log("stats: the stats file was unreadable and couldn't be moved aside");
    }
    return null;
  }

  /** Parse the file (read-only; null when missing or unreadable). */
  static read(path: string): StatsFile | null {
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as StatsFile;
      return j && j.version === 1 && j.lifetime && j.days ? j : null;
    } catch {
      return null;
    }
  }

  /** Is this request from a tester (ignored IP or a marked user agent)? */
  isIgnored(ip: string, ua: string | undefined): boolean {
    const u = (ua || "").toLowerCase();
    return this.ipIgnored(ip) || this.uaMarks.some((m) => u.includes(m));
  }

  private today(): DayStats {
    return (this.data.days[day(this.now())] ??= emptyDay());
  }

  /** A game page load. Counts a page view, and a unique visitor once per IP per UTC day. */
  visit(ip: string, ua: string | undefined) {
    if (this.isIgnored(ip, ua)) return;
    const d = day(this.now());
    if (d !== this.visitorDay) { this.visitorDay = d; this.visitorKey = randomBytes(32); this.seen = new Set(); }
    const t = this.today();
    t.pageViews++; this.data.lifetime.pageViews++;
    const h = createHmac("sha256", this.visitorKey).update(ip).digest("hex").slice(0, 16);
    if (!this.seen.has(h)) {
      if (this.seen.size < MAX_HASHES) this.seen.add(h);
      t.visitors++; this.data.lifetime.visitors++;
    }
    this.changed();
  }

  /** A share-page load (/award/<id>). */
  awardView(ip: string, ua: string | undefined) {
    if (this.isIgnored(ip, ua)) return;
    this.today().awardViews++; this.data.lifetime.awardViews++;
    this.changed();
  }

  /**
   * Count a player event once per world. Returns true when it was counted; the caller saves
   * the world (statsCounted changed). Worlds marked statsIgnore are skipped.
   */
  record(world: Countable, e: StatEvent, atMs = this.now()): boolean {
    if (world.statsIgnore) return false;
    const k = eventKey(e);
    const done = (world.statsCounted ??= []);
    if (done.includes(k)) return false;
    done.push(k);
    bump((this.data.days[day(atMs)] ??= emptyDay()), e);
    bump(this.data.lifetime, e);
    this.changed();
    return true;
  }

  /** Graduates whose worlds were evicted before backfill: counted from the award files. */
  addGraduates(n: number, atMs: number) {
    for (let i = 0; i < n; i++) { bump((this.data.days[day(atMs)] ??= emptyDay()), { type: "grad" }); bump(this.data.lifetime, { type: "grad" }); }
    if (n) this.changed();
  }

  /** Report: lifetime, the last `days` days (newest first) and averages; counts only. */
  snapshot(days = 30) {
    const avg = (q: Record<string, { points: number; attempts: number }>) => {
      let p = 0, a = 0;
      for (const v of Object.values(q)) { p += v.points; a += v.attempts; }
      return a ? Math.round((p / a) * 10) / 10 : null;
    };
    const keys = Object.keys(this.data.days).sort().reverse().slice(0, Math.max(1, Math.min(days, 3660)));
    return {
      network: this.data.network, since: this.data.createdAt, backfill: this.data.backfill, generatedAt: new Date(this.now()).toISOString(),
      notes: "Days are UTC. visitors = unique per day (daily-rotated hash, no IPs kept); lifetime visitors = sum of daily uniques. Player counts are once per world; testers excluded.",
      lifetime: { ...this.data.lifetime, avgFirstTryQuizPoints: avg(this.data.lifetime.quizFirstTry) },
      days: keys.map((d) => ({ date: d, ...this.data.days[d], avgFirstTryQuizPoints: avg(this.data.days[d].quizFirstTry) })),
    };
  }

  private changed() {
    if (this.flushMs <= 0) return this.flush();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  /**
   * Atomic write: a fixed temp file in the same directory, then rename. Never throws: a failed
   * save logs one short line (once until a save works again) and the counts stay in memory for
   * the next try, so a full or read-only disk can't break the game.
   */
  flush(): boolean {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
      renameSync(tmp, this.path);
      this.failing = false;
      return true;
    } catch {
      if (!this.failing) this.log("stats: couldn't save the counts; will retry on the next change");
      this.failing = true;
      return false;
    }
  }
}

/** Plain-text table for `npm run dch -- stats`. */
export function formatStats(s: ReturnType<Stats["snapshot"]>, levelIds: string[]): string {
  const L = s.lifetime;
  const per = (r: Record<string, number>) => levelIds.map((id) => `${id} ${r[id] ?? 0}`).join(", ");
  const lines = [
    `DCH stats (${s.network}), since ${s.since}${s.backfill ? `; backfilled ${s.backfill.worlds} worlds, ${s.backfill.awards} awards at ${s.backfill.at}` : ""}`,
    "",
    `Lifetime: visitors ${L.visitors} (sum of daily uniques), page views ${L.pageViews}, card views ${L.awardViews}, worlds started ${L.worldsStarted}, graduates ${L.graduates}, avg first-try quiz points ${L.avgFirstTryQuizPoints ?? "-"}/30`,
    `  levels completed: ${per(L.levelsCompleted)}`,
    `  quizzes passed:   ${per(L.quizzesPassed)}`,
    "",
    "Date (UTC)   visitors  views  cards  worlds  grads  quiz avg",
    ...s.days.map((d) => `${d.date}  ${String(d.visitors).padStart(8)}  ${String(d.pageViews).padStart(5)}  ${String(d.awardViews).padStart(5)}  ${String(d.worldsStarted).padStart(6)}  ${String(d.graduates).padStart(5)}  ${d.avgFirstTryQuizPoints ?? "-"}`),
    "",
    s.notes,
  ];
  return lines.join("\n");
}
