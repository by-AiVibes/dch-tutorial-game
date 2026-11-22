// Second-layer abuse protection (the reverse proxy is the first layer):
// per-IP fixed-window rate limits by endpoint class, and a cap on queued ledger work.

export interface LimitRule {
  /** Max requests per window per IP. */
  max: number;
  windowMs: number;
  /** Optional cap across ALL IPs in the same window (used for reset-world). */
  globalMax?: number;
}

export type LimitClass = "read" | "heavy" | "reset";

/** Defaults; override with DCH_RL_<CLASS>_MAX / DCH_RL_<CLASS>_WINDOW_MS. */
export const DEFAULT_RULES: Record<LimitClass, LimitRule> = {
  read: { max: 120, windowMs: 60_000 }, // state, static, seats
  heavy: { max: 12, windowMs: 60_000 }, // level runs, /api/objects, /api/account, amendments
  reset: { max: 2, windowMs: 3_600_000, globalMax: 6 }, // reset-world spends faucet requests
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
export function classify(method: string, path: string): LimitClass {
  if (path === "/api/reset-world") return "reset";
  if (path === "/api/objects" || path.startsWith("/api/account/") || path === "/api/amendments" || path.startsWith("/api/levels/")) return "heavy";
  return "read";
}

export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  private global = new Map<LimitClass, { start: number; count: number }>();
  private lastSweep = 0;
  private rules: Record<LimitClass, LimitRule>;
  private now: () => number;
  private maxKeys: number;
  constructor(rules: Record<LimitClass, LimitRule>, now: () => number = Date.now, maxKeys = 50_000) {
    this.rules = rules;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** Returns 0 if allowed, else seconds until the window resets. */
  check(ip: string, cls: LimitClass): number {
    const t = this.now();
    const rule = this.rules[cls];
    this.sweep(t);
    if (rule.globalMax) {
      const g = this.global.get(cls);
      if (!g || t - g.start >= rule.windowMs) this.global.set(cls, { start: t, count: 0 });
      const gg = this.global.get(cls)!;
      if (gg.count >= rule.globalMax) return Math.ceil((gg.start + rule.windowMs - t) / 1000);
    }
    const key = `${cls}|${ip}`;
    let e = this.hits.get(key);
    if (!e || t - e.start >= rule.windowMs) {
      if (!e && this.hits.size >= this.maxKeys) return Math.ceil(rule.windowMs / 1000); // memory cap under a flood
      e = { start: t, count: 0 };
      this.hits.set(key, e);
    }
    if (e.count >= rule.max) return Math.ceil((e.start + rule.windowMs - t) / 1000);
    e.count++;
    if (rule.globalMax) this.global.get(cls)!.count++;
    return 0;
  }

  private sweep(t: number) {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    const longest = Math.max(...Object.values(this.rules).map((r) => r.windowMs));
    for (const [k, v] of this.hits) if (t - v.start >= longest) this.hits.delete(k);
  }

  get size() {
    return this.hits.size;
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

/**
 * Client IP. Behind a trusted local reverse proxy (TRUST_PROXY=1), use the last
 * X-Forwarded-For hop (the one the proxy appended); otherwise the socket address.
 */
export function clientIp(remote: string | undefined, xff: string | string[] | undefined, trustProxy: boolean): string {
  if (trustProxy && xff) {
    const parts = (Array.isArray(xff) ? xff.join(",") : xff).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return remote ?? "unknown";
}
