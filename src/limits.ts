import { isIP } from "node:net";

// Second-layer abuse protection (the reverse proxy is the first layer):
// per-IP fixed-window rate limits by endpoint class, and a cap on queued ledger work.

export interface LimitRule {
  /** Max requests per window per IP. */
  max: number;
  windowMs: number;
  /** Optional cap across ALL IPs in the same window (used for reset-world). */
  globalMax?: number;
}

export type LimitClass = "read" | "account" | "heavy" | "reset" | "world" | "award" | "awardview" | "quiz";

/** Defaults; override with DCH_RL_<CLASS>_MAX / DCH_RL_<CLASS>_WINDOW_MS (e.g. for a workshop behind one NAT). */
export const DEFAULT_RULES: Record<LimitClass, LimitRule> = {
  read: { max: 120, windowMs: 60_000 }, // state, static, seats
  account: { max: 60, windowMs: 60_000 }, // Level 0 balance polling
  heavy: { max: 12, windowMs: 60_000 }, // level runs, /api/objects, /api/amendments
  reset: { max: 2, windowMs: 3_600_000, globalMax: 6 }, // reset-world spends faucet requests
  // "Start my world" also spends faucet requests (6 accounts). Per IP here; the global per-hour
  // cap and the stored-world cap live in the Game (DCH_MAX_NEW_WORLDS_PER_HOUR, DCH_MAX_WORLDS).
  world: { max: 3, windowMs: 3_600_000 },
  award: { max: 10, windowMs: 3_600_000 }, // POST /api/award: create or rename your card
  awardview: { max: 60, windowMs: 60_000, globalMax: 600 }, // /award/<id> page + PNG (link previews fetch these)
  quiz: { max: 30, windowMs: 60_000 }, // POST /api/quiz/answer and /api/quiz/retry
};

export function rulesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<LimitClass, LimitRule> {
  const out = structuredClone(DEFAULT_RULES);
  for (const k of Object.keys(out) as LimitClass[]) {
    const max = Number(env[`DCH_RL_${k.toUpperCase()}_MAX`]);
    const win = Number(env[`DCH_RL_${k.toUpperCase()}_WINDOW_MS`]);
    if (max > 0) out[k].max = max;
    if (win > 0) out[k].windowMs = win;
  }
  return out;
}

/** Which class a request falls into. */
export function classify(_method: string, path: string): LimitClass {
  if (path === "/api/reset-world") return "reset";
  if (path === "/api/world/start") return "world";
  if (path === "/api/award") return "award";
  if (path.startsWith("/api/quiz/")) return "quiz";
  if (path.startsWith("/award/")) return "awardview";
  if (path.startsWith("/api/account/") || path === "/api/stats") return "account"; // stats: slows token guessing
  if (path === "/api/objects" || path === "/api/amendments" || path.startsWith("/api/levels/")) return "heavy";
  return "read";
}

/** How many live run streams one IP may hold open at once. A refresh replaces its own stream. */
export const MAX_SSE_STREAMS_PER_IP = 4;

/**
 * After a level run finishes, keep the live stream open this long so the confirming
 * ledger close (a few seconds on devnet and testnet) can still be relayed.
 */
export const SSE_LEDGER_GRACE_MS = 4_000;

/** Concurrent SSE streams, keyed like the rate limiter (IPv4 as-is, IPv6 by /64). */
export class StreamGate {
  private open = new Map<string, number>();

  tryAcquire(ip: string): boolean {
    const key = ipKey(ip || "unknown");
    const n = this.open.get(key) ?? 0;
    if (n >= MAX_SSE_STREAMS_PER_IP) return false;
    this.open.set(key, n + 1);
    return true;
  }

  release(ip: string): void {
    const key = ipKey(ip || "unknown");
    const n = (this.open.get(key) ?? 0) - 1;
    if (n <= 0) this.open.delete(key);
    else this.open.set(key, n);
  }

  count(ip: string): number {
    return this.open.get(ipKey(ip || "unknown")) ?? 0;
  }
}

/**
 * Rate-limit key for an IP: IPv4 as-is (v4-mapped IPv6 unwrapped), IPv6 bucketed by /64
 * (one host usually owns a whole /64). Anything that isn't an IP becomes "unknown", so
 * keys are always short.
 */
export function ipKey(ip: string): string {
  let a = ip.trim();
  if (a.toLowerCase().startsWith("::ffff:") && isIP(a.slice(7)) === 4) a = a.slice(7);
  const v = isIP(a);
  if (v === 4) return a;
  if (v !== 6) return "unknown";
  const [head, tail = ""] = a.toLowerCase().split("%")[0].split("::");
  const h = head ? head.split(":") : [];
  const t = a.includes("::") ? (tail ? tail.split(":") : []) : [];
  const full = a.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

type Entry = { start: number; count: number };

export class RateLimiter {
  /** One map per class, so each class expires on its own window. Insertion order = oldest first. */
  private hits = new Map<LimitClass, Map<string, Entry>>();
  private global = new Map<LimitClass, Entry>();
  private lastSweep = new Map<LimitClass, number>();
  private rules: Record<LimitClass, LimitRule>;
  private now: () => number;
  private maxKeys: number;
  constructor(rules: Record<LimitClass, LimitRule>, now: () => number = Date.now, maxKeys = 50_000) {
    this.rules = rules;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** Returns 0 if allowed, else whole seconds until this request could succeed. */
  check(ip: string, cls: LimitClass): number {
    const t = this.now();
    const rule = this.rules[cls];
    const map = this.mapFor(cls);
    if (t - (this.lastSweep.get(cls) ?? 0) >= Math.min(rule.windowMs, 60_000)) this.sweep(cls, t);
    if (rule.globalMax) {
      let g = this.global.get(cls);
      if (!g || t - g.start >= rule.windowMs) this.global.set(cls, (g = { start: t, count: 0 }));
      if (g.count >= rule.globalMax) return secs(g.start + rule.windowMs - t);
    }
    const key = ipKey(ip);
    let e = map.get(key);
    if (e && t - e.start >= rule.windowMs) {
      map.delete(key); // re-insert below so order stays oldest-first
      e = undefined;
    }
    if (!e) {
      if (map.size >= this.maxKeys) {
        this.sweep(cls, t); // expire first; only refuse if the table is still full
        if (map.size >= this.maxKeys) {
          const oldest = map.values().next().value as Entry;
          return secs(oldest.start + rule.windowMs - t); // real wait until a slot frees
        }
      }
      e = { start: t, count: 0 };
      map.set(key, e);
    }
    if (e.count >= rule.max) return secs(e.start + rule.windowMs - t);
    e.count++;
    if (rule.globalMax) this.global.get(cls)!.count++;
    return 0;
  }

  private mapFor(cls: LimitClass) {
    let m = this.hits.get(cls);
    if (!m) this.hits.set(cls, (m = new Map()));
    return m;
  }

  private sweep(cls: LimitClass, t: number) {
    this.lastSweep.set(cls, t);
    const win = this.rules[cls].windowMs;
    const m = this.mapFor(cls);
    for (const [k, v] of m) {
      if (t - v.start >= win) m.delete(k);
      else break; // oldest-first: the rest are newer
    }
  }

  /** Tracked keys (all classes, or one). */
  size(cls?: LimitClass): number {
    if (cls) return this.mapFor(cls).size;
    let n = 0;
    for (const m of this.hits.values()) n += m.size;
    return n;
  }
}

const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/** A capacity limit with a known wait: the server answers with this status and Retry-After. */
export class CapError extends Error {
  status: 429 | 503;
  retryAfter: number;
  constructor(message: string, status: 429 | 503, retryAfterSeconds: number) {
    super(message);
    this.status = status;
    this.retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

/** Caps how much ledger work can wait in the engine's single queue. */
export class QueueGate {
  depth = 0;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth >= this.max) throw new BusyError();
    this.depth++;
    try {
      return await fn();
    } finally {
      this.depth--;
    }
  }
}

export class BusyError extends Error {
  constructor() {
    super("The game is busy right now. Please try again in a few seconds.");
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Client IP. Proxy headers are trusted only when TRUST_PROXY is on AND the socket peer is
 * loopback (i.e. the local reverse proxy). Prefer X-Real-IP (Caddy: header_up X-Real-IP
 * {remote_host}), else the last X-Forwarded-For hop. Values must pass net.isIP(); otherwise
 * fall back to the socket address.
 */
export function clientIp(
  remote: string | undefined,
  headers: { "x-real-ip"?: string | string[]; "x-forwarded-for"?: string | string[] },
  trustProxy: boolean,
): string {
  const sock = remote ?? "unknown";
  if (!trustProxy || !LOOPBACK.has(sock)) return sock;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(",") : v ?? "");
  const real = one(headers["x-real-ip"]).trim();
  if (real && isIP(real)) return real;
  const hops = one(headers["x-forwarded-for"]).split(",").map((x) => x.trim()).filter(Boolean);
  const last = hops[hops.length - 1];
  if (last && isIP(last)) return last;
  return sock;
}
