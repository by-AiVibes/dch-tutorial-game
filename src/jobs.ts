/**
 * Background level runs. A run can take minutes (Level 7 waits ~4 minutes for the vault's
 * investment phase), longer than a phone keeps one fetch alive: iOS drops it when the screen
 * locks or the tab is backgrounded ("Load failed") even though the ledger work finishes.
 * So POST /api/levels/... with {"async": true} answers at once with a job id, and the page
 * polls GET /api/jobs/<id> until the run is done. Ids are random (128 bits), kept in memory
 * only, and expire; the result itself is also saved in the world, so a lost id costs nothing.
 */
import { randomBytes } from "node:crypto";

export type JobStatus = "running" | "done" | "error";
export interface Job {
  id: string;
  status: JobStatus;
  /** World key + level + part, so a second press of the same run joins the running job. */
  slot: string;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
  /** HTTP status the synchronous route would have used for this error (400, 429, 503…). */
  errorStatus?: number;
}

/**
 * What a finished job keeps: the message, points and score, plus the last few transaction
 * results the page links to. Never the whole world view (that is re-read with /api/state).
 */
export function slimResult(r: unknown): unknown {
  if (!r || typeof r !== "object") return r;
  const o = r as Record<string, unknown>;
  const view = o.view as { score?: number; maxScore?: number } | undefined;
  const results = Array.isArray(o.results) ? (o.results as Record<string, unknown>[]).slice(-4).map((t) => ({ type: t.type, engineResult: t.engineResult, hash: t.hash })) : [];
  return { ok: o.ok, message: o.message, added: o.added ?? 0, ...(o.comingSoon ? { comingSoon: true } : {}), ...(view ? { score: view.score, maxScore: view.maxScore } : {}), results };
}

export const JOB_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export class JobStore {
  private jobs = new Map<string, Job>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;
  constructor(ttlMs = 15 * 60_000, max = 2000, now = () => Date.now()) {
    this.ttlMs = ttlMs; this.max = max; this.now = now;
  }

  /** Start fn in the background, or return the job already running for the same slot. */
  start(slot: string, fn: () => Promise<unknown>, errorStatus: (e: unknown) => number = () => 400): Job {
    this.sweep();
    for (const j of this.jobs.values()) if (j.slot === slot && j.status === "running") return j;
    if (this.jobs.size >= this.max) {
      // Drop the oldest finished job; if every job is still running, refuse.
      const old = [...this.jobs.values()].filter((j) => j.status !== "running").sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!old) throw new Error("Too many level runs in progress. Try again in a minute.");
      this.jobs.delete(old.id);
    }
    const job: Job = { id: randomBytes(16).toString("base64url"), status: "running", slot, startedAt: this.now() };
    this.jobs.set(job.id, job);
    fn().then(
      (r) => { job.status = "done"; job.result = slimResult(r); job.finishedAt = this.now(); },
      (e) => { job.status = "error"; job.error = e instanceof Error ? e.message : String(e); job.errorStatus = errorStatus(e); job.finishedAt = this.now(); },
    );
    return job;
  }

  get(id: string): Job | null {
    this.sweep();
    return JOB_ID_RE.test(id) ? this.jobs.get(id) ?? null : null;
  }

  /** What the browser sees: never the slot (it holds the world address). */
  static view(j: Job) {
    return { job: j.id, status: j.status, elapsedSeconds: Math.round(((j.finishedAt ?? Date.now()) - j.startedAt) / 1000),
      ...(j.status === "done" ? { result: j.result } : {}),
      ...(j.status === "error" ? { error: j.error, errorStatus: j.errorStatus ?? 400, busy: j.errorStatus === 503 || j.errorStatus === 429 } : {}) };
  }

  get size() { return this.jobs.size; }

  private sweep() {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j.status !== "running" && t - (j.finishedAt ?? t) > this.ttlMs) this.jobs.delete(id);
  }
}
