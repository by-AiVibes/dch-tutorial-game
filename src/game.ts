// Game engine: a shared world per network (CLI / instructor) plus one world per player, keyed
// by the player's classic address. Operations are serialized per world; seats, levels, scoring.

import { Wallet, type Client, type SubmittableTransaction } from "xrpl";
import { checkAmendments, featureEnabled } from "./amendments.ts";
import type { NetworkConfig } from "./config.ts";
import { connect, fundNew, submit } from "./ledger.ts";
import { findLevel, LEVELS, SCORED_LEVELS } from "./levels/index.ts";
import type { AccountKey, LevelContext } from "./levels/types.ts";
import { award, judgeShouldFail, MAX_SCORE, total, type Part } from "./scoring.ts";
import { botSeats, canAct, claimSeat, isRole, releaseSeat, ROLES } from "./seats.ts";
import { CapError, QueueGate } from "./limits.ts";
import { emptyProgress, publicQuiz, QUIZ_MAX, QUIZ_PASS, QUIZ_POINTS, QUIZZES, quizPoints, type QuizProgress } from "./quizzes.ts";
import { awardCount, cleanName, loadAward, newAwardId, saveAward, SHORT, type AwardRecord } from "./award.ts";
import { deleteWorld, emptyWorld, listPlayerWorlds, load, publicView, save, type RecentResult, type WorldState } from "./store.ts";
import { cleanAddress } from "./secrets.ts";

/** Accounts funded per world: the five role seats plus one holder bot. */
export const WORLD_ACCOUNTS: AccountKey[] = [...ROLES, "holderBot"];
const RECENT_MAX = 50;
const envNum = (k: string, d: number) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

/** null = the shared world; otherwise a validated classic address. */
export type WorldKey = string | null;

export interface WorldCaps {
  /** Max per-player worlds kept on disk; least-recently-used idle worlds are evicted. */
  maxWorlds: number;
  /** A world idle at least this long may be evicted to make room. */
  minIdleMs: number;
  /** New per-player worlds per rolling hour, server-wide (each funds 6 faucet accounts). */
  newPerHour: number;
  /** Max stored graduation awards (each is a small JSON record plus a cached PNG). */
  maxAwards?: number;
}
export const defaultCaps = (): WorldCaps => ({
  maxAwards: envNum("DCH_MAX_AWARDS", 2000),
  maxWorlds: envNum("DCH_MAX_WORLDS", 100),
  minIdleMs: envNum("DCH_WORLD_MIN_IDLE_MS", 3_600_000),
  newPerHour: envNum("DCH_MAX_NEW_WORLDS_PER_HOUR", 30),
});

export class Game {
  private shared: WorldState;
  private worlds = new Map<string, WorldState>();
  /** owner -> last use (ms), for LRU eviction. Seeded from file times at startup. */
  private lastUsed = new Map<string, number>();
  /** New worlds whose start is still funding (counted against the stored-world cap). */
  private pending = new Set<string>();
  private created: number[] = [];
  private queues = new Map<string, Promise<unknown>>();
  readonly caps: WorldCaps;
  private now: () => number;
  private client: Client | null = null;
  /** Read-only lookups (balances, objects) skip the level queue but have their own small cap. */
  private readGate = new QueueGate(Number(process.env.DCH_MAX_READS) > 0 ? Number(process.env.DCH_MAX_READS) : 4);
  private connecting: Promise<Client> | null = null;
  private gate = new QueueGate(Number(process.env.DCH_MAX_QUEUE) > 0 ? Number(process.env.DCH_MAX_QUEUE) : 8);
  readonly cfg: NetworkConfig;
  log: (msg: string) => void;

  constructor(cfg: NetworkConfig, log: (msg: string) => void = () => {}, caps: WorldCaps = defaultCaps(), now: () => number = Date.now) {
    this.cfg = cfg;
    this.log = log;
    this.caps = caps;
    this.now = now;
    this.shared = load(cfg.name);
    for (const w of listPlayerWorlds(cfg.name)) this.lastUsed.set(w.owner, w.mtimeMs);
  }

  /** The world for a key: shared, a stored player world, or an empty (unsaved) one. */
  private st(key: WorldKey): WorldState {
    if (key === null) return this.shared;
    let w = this.worlds.get(key);
    if (!w) {
      w = load(this.cfg.name, key);
      if (w.world) this.worlds.set(key, w);
    }
    return w;
  }

  /** Mark a stored player world as recently used (mutating calls only, not reads). */
  private touch(key: WorldKey) {
    if (key !== null && this.lastUsed.has(key)) this.lastUsed.set(key, this.now());
  }

  private persist(w: WorldState) {
    save(w);
    if (w.owner) { this.worlds.set(w.owner, w); this.lastUsed.set(w.owner, this.now()); }
  }

  /** Validate a world key from the outside: a classic address, or null for the shared world. */
  static key(raw: unknown): WorldKey {
    if (raw == null || raw === "") return null;
    return cleanAddress(raw);
  }

  /**
   * Serialize mutating operations per world, so requests can't interleave one world's ledger
   * steps; different worlds run side by side. QueueGate caps total queued work (BusyError -> 503).
   */
  private exclusive<T>(key: WorldKey, fn: () => Promise<T>): Promise<T> {
    const q = key ?? "";
    return this.gate.run(() => {
      const prev = this.queues.get(q) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      const tail = run.catch(() => undefined);
      this.queues.set(q, tail);
      void tail.then(() => { if (this.queues.get(q) === tail) this.queues.delete(q); });
      return run;
    });
  }

  /** Stored per-player worlds (for tests and health). */
  get worldCount() {
    return this.lastUsed.size;
  }

  /** Current queued + running ledger operations (for tests and health). */
  get queueDepth() {
    return this.gate.depth;
  }

  private async ledger(): Promise<Client> {
    if (this.client?.isConnected()) return this.client;
    // One connection attempt at a time, even with concurrent read-only lookups.
    this.connecting ??= connect(this.cfg).then((c) => (this.client = c)).finally(() => (this.connecting = null));
    return this.connecting;
  }

  async close(): Promise<void> {
    if (this.client?.isConnected()) await this.client.disconnect();
  }

  /** A blank view: no world, no scores (used when the shared world is off over HTTP). */
  blankView() {
    return this.view(null, true);
  }

  view(key: WorldKey = null, blank = false) {
    const state = blank ? emptyWorld(this.cfg.name) : this.st(key);
    const net = this.cfg.name;
    const fill = (t: string) => t.replaceAll("{network}", net).replaceAll("{Network}", net[0].toUpperCase() + net.slice(1));
    const levels = LEVELS.map((l) => ({
      id: l.id, n: l.n, title: fill(l.title), feature: l.feature, priority: !!l.priority,
      goal: fill(l.goal), shouldFail: l.shouldFail, rejectReason: l.rejectReason, bots: l.bots,
      goalRoles: l.goalRoles, shouldFailRoles: l.shouldFailRoles, docs: l.docs, explainer: l.explainer?.map(fill) ?? null,
      available: this.levelAvailable(l.id),
      playable: !!l.runGoal && this.levelAvailable(l.id),
      score: state.scores[l.id] ?? { goal: false, shouldFail: false },
      quiz: this.quizView(state, l.id),
    }));
    return {
      ...publicView(state),
      amendments: this.shared.amendments,
      owner: blank ? null : key,
      network: this.cfg.name,
      explorer: this.cfg.explorer,
      faucetHost: this.cfg.faucetHost,
      score: total(state.scores) + quizPoints(state.quizzes),
      maxScore: MAX_SCORE + QUIZ_MAX,
      levelScore: total(state.scores),
      levelMax: MAX_SCORE,
      quizScore: quizPoints(state.quizzes),
      quizMax: QUIZ_MAX,
      scoredLevels: SCORED_LEVELS.length,
      levels,
    };
  }

  /** Public quiz state for a level: questions and choices, your answers, and a "why" only for wrong ones. */
  private quizView(state: WorldState, levelId: string) {
    const qs = publicQuiz(levelId);
    if (!qs) return null;
    const p = state.quizzes?.[levelId];
    return {
      questions: qs,
      answers: (p?.answers ?? []).map((a, i) => ({ choice: a.choice, correct: a.correct, ...(a.correct ? {} : { why: QUIZZES[levelId][i].why }) })),
      passed: !!p?.passed,
      points: p?.points ?? 0,
      firstDone: !!p && (p.attempts > 1 || p.answers.length >= qs.length),
      maxPoints: qs.length * QUIZ_POINTS,
      pass: QUIZ_PASS,
      attempts: p?.attempts ?? 0,
      unlocked: this.quizUnlocked(state, levelId, state.owner ?? null),
    };
  }

  /** A level's quiz opens once the level itself is done (Level 0: world + linked seat; explainers: any time in a world). */
  private quizUnlocked(state: WorldState, levelId: string, key: string | null): boolean {
    const l = findLevel(levelId);
    if (!l || !QUIZZES[levelId] || !state.world || !this.levelAvailable(levelId)) return false;
    if (l.n === 0) return Object.values(state.seats).some((x) => !!x.wallet && (key === null || x.wallet === key));
    if (SCORED_LEVELS.includes(l)) return !!(state.scores[levelId]?.goal && state.scores[levelId]?.shouldFail);
    return true;
  }

  /**
   * Answer the next question of a level's quiz. Checked here, never in the browser. Questions
   * are answered in order; after the last one the attempt passes with QUIZ_PASS correct
   * or fails and can be retried. Points come from the FIRST attempt only (correct x QUIZ_POINTS);
   * later attempts only unlock advancement.
   */
  answerQuiz(levelId: unknown, q: unknown, choice: unknown, rawKey: unknown) {
    const key = Game.key(rawKey);
    const id = typeof levelId === "string" && Object.hasOwn(QUIZZES, levelId) ? levelId : null;
    if (!id) return Promise.reject(new Error("unknown quiz"));
    const qs = QUIZZES[id];
    if (!Number.isInteger(q) || (q as number) < 0 || (q as number) >= qs.length) return Promise.reject(new Error("bad question number"));
    const qi = q as number;
    if (!Number.isInteger(choice) || (choice as number) < 0 || (choice as number) >= qs[qi].choices.length) return Promise.reject(new Error("bad choice"));
    return this.exclusive(key, async () => {
      const state = this.st(key);
      if (key !== null && !state.world) throw new Error("Start your world first.");
      if (!this.quizUnlocked(state, id, key)) throw new Error("Finish this level before its quiz.");
      state.quizzes ??= {};
      const p: QuizProgress = (state.quizzes[id] ??= emptyProgress());
      if (p.passed) throw new Error("You already passed this quiz.");
      if (p.answers.length >= qs.length) throw new Error("This attempt is over: press Try again.");
      if (qi !== p.answers.length) throw new Error(`Answer question ${p.answers.length + 1} next.`);
      const correct = choice === qs[qi].answer;
      p.answers.push({ choice: choice as number, correct });
      let done = false;
      const right = p.answers.filter((a) => a.correct).length;
      if (p.answers.length === qs.length) {
        done = true;
        if (p.attempts === 1) p.points = right * QUIZ_POINTS;
        if (right >= QUIZ_PASS) p.passed = true;
      }
      this.touch(key);
      this.persist(state);
      return { correct, ...(correct ? {} : { why: qs[qi].why }), done, passed: p.passed, right, of: qs.length, view: this.view(key) };
    });
  }

  /** Start a fresh attempt after a failed one: no lockout; it can pass the quiz but adds no points. */
  retryQuiz(levelId: unknown, rawKey: unknown) {
    const key = Game.key(rawKey);
    const id = typeof levelId === "string" && Object.hasOwn(QUIZZES, levelId) ? levelId : null;
    if (!id) return Promise.reject(new Error("unknown quiz"));
    return this.exclusive(key, async () => {
      const state = this.st(key);
      if (key !== null && !state.world) throw new Error("Start your world first.");
      const p = state.quizzes?.[id];
      if (!p || p.passed) throw new Error(p?.passed ? "You already passed this quiz." : "Nothing to retry yet.");
      p.answers = [];
      p.attempts++;
      this.touch(key);
      this.persist(state);
      return this.view(key);
    });
  }

  levelAvailable(id: string): boolean {
    const l = findLevel(id);
    if (!l) return false;
    if (l.feature === null) return true;
    return featureEnabled(this.shared.amendments, l.feature);
  }

  claim(role: string, player: string, wallet: string | null = null, key: WorldKey = null) {
    if (!isRole(role)) throw new Error("unknown role");
    const state = this.st(key);
    if (key !== null && !state.world) throw new Error("Start your world first.");
    this.touch(key);
    state.seats = claimSeat(state.seats, role, player, wallet);
    this.persist(state);
    return this.view(key);
  }

  release(role: string, player: string, key: WorldKey = null) {
    if (!isRole(role)) throw new Error("unknown role");
    const state = this.st(key);
    if (key !== null && !state.world) throw new Error("Start your world first.");
    this.touch(key);
    state.seats = releaseSeat(state.seats, role, player);
    this.persist(state);
    return this.view(key);
  }

  /** Level 0: live balance and reserve for a player's address (address only; read-only). */
  account(address: string) {
    return this.readGate.run(async () => {
      const client = await this.ledger();
      const si = await client.request({ command: "server_info" });
      const vl = si.result.info.validated_ledger;
      try {
        const r = await client.request({ command: "account_info", account: address, ledger_index: "validated" });
        return { address, funded: true, balanceXrp: Number(r.result.account_data.Balance) / 1e6, reserveBaseXrp: vl?.reserve_base_xrp ?? null, network: this.cfg.name };
      } catch (e) {
        if (/actNotFound/.test(String((e as { data?: { error?: string } }).data?.error ?? e))) {
          return { address, funded: false, balanceXrp: 0, reserveBaseXrp: vl?.reserve_base_xrp ?? null, network: this.cfg.name };
        }
        throw e;
      }
    });
  }

  refreshAmendments() {
    return this.exclusive(null, async () => {
      this.shared.amendments = await checkAmendments(await this.ledger(), this.cfg.name);
      save(this.shared);
      return this.shared.amendments;
    });
  }

  /** Fund the accounts a world needs; throws (and funds nothing further) on a faucet failure. */
  private async fundAccounts(client: Client): Promise<WorldState["accounts"]> {
    const accounts: WorldState["accounts"] = {};
    for (const k of WORLD_ACCOUNTS) {
      this.log(`funding ${k} from the ${this.cfg.name} faucet`);
      const w = await fundNew(client, this.cfg);
      accounts[k] = { address: w.address, seed: w.seed as string };
    }
    return accounts;
  }

  /**
   * "Start my world": a fresh world just for this player (keyed by their classic address),
   * funded through the same faucet path as reset-world. Returns the existing world unless
   * fresh = true. Caps: new worlds per hour (429) and stored worlds (LRU-evicts idle ones,
   * else 503), both with Retry-After.
   */
  async startWorld(rawKey: unknown, fresh = false) {
    const key = Game.key(rawKey);
    if (key === null) throw new Error("world must be your classic XRPL address (r…)");
    return this.exclusive(key, async () => {
      const existing = this.st(key);
      this.touch(key);
      if (existing.world && !fresh) return this.view(key);
      const t = this.now();
      this.created = this.created.filter((x) => t - x < 3_600_000);
      if (this.created.length >= this.caps.newPerHour) {
        throw new CapError("Too many new worlds this hour on this server. Try again later.", 429, (this.created[0] + 3_600_000 - t) / 1000);
      }
      const isNew = !existing.world;
      if (isNew) { this.makeRoom(key, t); this.pending.add(key); }
      this.created.push(t); // counts even if the faucet fails: the requests were spent
      let accounts: WorldState["accounts"];
      let client: Client;
      try {
        client = await this.ledger();
        accounts = await this.fundAccounts(client);
      } catch (e) {
        if (isNew) this.pending.delete(key);
        throw new Error(`${(e as Error).message} Your world wasn't created; try again in a minute.`);
      }
      if (!this.shared.amendments) { this.shared.amendments = await checkAmendments(client, this.cfg.name); save(this.shared); }
      const w: WorldState = { ...emptyWorld(this.cfg.name), owner: key, world: existing.world + 1, createdAt: new Date(t).toISOString(), accounts };
      this.persist(w);
      this.pending.delete(key);
      this.log(`player world ${key.slice(0, 6)}… #${w.world} ready on ${this.cfg.name}`);
      return this.view(key);
    });
  }

  /**
   * Graduation: only when this player's own world really has every level complete, checked on
   * the server: a seat linked to the player's address (Level 0) and both parts of every scored
   * level that is available on this network. Returns the award (stable random id per world).
   */
  async graduate(rawKey: unknown, rawName: unknown) {
    const key = Game.key(rawKey);
    if (key === null) throw new Error("world must be your classic XRPL address (r…)");
    const name = cleanName(rawName);
    return this.exclusive(key, async () => {
      const state = this.st(key);
      const missing = this.unfinished(state, key);
      if (missing.length) throw new Error(`Not graduated yet: finish ${missing.join(", ")} first.`);
      this.touch(key);
      let rec = state.award ? loadAward(state.award.id) : null;
      if (!rec) {
        if (awardCount() >= (this.caps.maxAwards ?? 2000)) throw new CapError("Too many awards stored on this server right now. Try again later.", 503, 3600);
        const date = state.award?.date ?? new Date(this.now()).toISOString().slice(0, 10);
        state.award = { id: newAwardId(), date };
        this.persist(state);
      }
      const next: AwardRecord = {
        id: state.award!.id, network: this.cfg.name, name, score: total(state.scores) + quizPoints(state.quizzes), maxScore: MAX_SCORE + QUIZ_MAX, date: state.award!.date,
        levels: this.requiredLevels().map((l) => ({ n: l.n, short: SHORT[l.id] ?? l.title })),
      };
      if (!rec || JSON.stringify(rec) !== JSON.stringify(next)) saveAward(next);
      return { id: next.id, name: next.name, score: next.score, maxScore: next.maxScore, date: next.date, page: `/award/${next.id}`, image: `/award/${next.id}.png` };
    });
  }

  /**
   * The levels graduation requires and the server verifies: Level 0 (seat linked to the
   * player's address) and every scored level live on this network, plus every live level with a
   * quiz (so the Level 8 explainer counts through its server-checked quiz). Every one of them
   * also needs its quiz passed.
   */
  private requiredLevels() {
    return LEVELS.filter((l) => l.n === 0 || (this.levelAvailable(l.id) && (SCORED_LEVELS.includes(l) || !!QUIZZES[l.id])));
  }

  /** Levels this world hasn't finished (empty = graduated). */
  private unfinished(state: WorldState, key: string): string[] {
    const out: string[] = [];
    if (!state.world) return ["Level 0 (build your world)"];
    if (!Object.values(state.seats).some((x) => x.wallet === key)) out.push("Level 0");
    for (const l of SCORED_LEVELS) {
      if (!this.levelAvailable(l.id)) continue;
      const sc = state.scores[l.id];
      if (!sc?.goal || !sc?.shouldFail) out.push(`Level ${l.n}`);
    }
    // every required level's quiz (Level 0, scored live levels, and the Level 8 explainer)
    for (const l of this.requiredLevels()) {
      if (QUIZZES[l.id] && !state.quizzes?.[l.id]?.passed) out.push(`the Level ${l.n} quiz`);
    }
    return out;
  }

  /** Keep stored worlds under the cap: evict the least-recently-used idle world, or refuse. */
  private makeRoom(key: string, t: number) {
    const others = [...this.lastUsed.entries()].filter(([k]) => k !== key);
    // Starts still funding count too, so concurrent starts can't overshoot the cap.
    const inFlight = [...this.pending].filter((k) => k !== key && !this.lastUsed.has(k)).length;
    if (others.length + inFlight < this.caps.maxWorlds) return;
    others.sort((a, b) => a[1] - b[1]);
    if (!others.length) throw new CapError("The server is full of new worlds right now. Try again in a minute.", 503, 60);
    const [oldKey, used] = others[0];
    if (t - used < this.caps.minIdleMs) {
      throw new CapError("The server is full of active worlds right now. Try again later.", 503, (used + this.caps.minIdleMs - t) / 1000);
    }
    deleteWorld(this.cfg.name, oldKey);
    this.worlds.delete(oldKey);
    this.lastUsed.delete(oldKey);
    this.log(`evicted idle world ${oldKey.slice(0, 6)}…`);
  }

  /**
   * reset-world: fund a fresh set of faucet accounts, seat bots in every role, clear scores,
   * memos and recent results, and re-check amendments. Idempotent: every run ends in the same
   * clean shape. State is only replaced after all funding succeeds, so a failed run leaves the
   * previous world intact and can simply be re-run. Old test accounts are abandoned on the test
   * network (nothing of value; test networks are reset periodically).
   */
  resetWorld() {
    return this.exclusive(null, async () => {
      const client = await this.ledger();
      let accounts: WorldState["accounts"];
      try {
        accounts = await this.fundAccounts(client);
      } catch (e) {
        throw new Error(`${(e as Error).message} The previous world is unchanged; try reset-world again later.`);
      }
      const amendments = await checkAmendments(client, this.cfg.name);
      this.shared = {
        ...this.shared,
        world: this.shared.world + 1,
        createdAt: new Date().toISOString(),
        accounts,
        seats: botSeats(),
        scores: {},
        quizzes: {},
        memos: {},
        recent: [],
        bugs: [],
        amendments,
      };
      save(this.shared);
      this.log(`world ${this.shared.world} ready on ${this.cfg.name}`);
      return this.view();
    });
  }

  play(levelId: string, part: Part, player: string | null, key: WorldKey = null) {
    return this.exclusive(key, async () => {
      const state = this.st(key);
      this.touch(key);
      const level = findLevel(levelId);
      if (!level) throw new Error("unknown level");
      if (!this.levelAvailable(levelId)) {
        return { ok: false, comingSoon: true, message: `Coming soon: ${level.feature} is not enabled on ${this.cfg.name} yet.`, added: 0, view: this.view(key) };
      }
      const run = part === "goal" ? level.runGoal : level.runShouldFail;
      if (!run) return { ok: false, comingSoon: true, message: "This level's interactive steps are coming in a later slice.", added: 0, view: this.view(key) };
      if (!state.world) throw new Error(key ? "Start your world first (Level 0)." : "No world yet. Run reset-world first.");
      const roles = part === "goal" ? level.goalRoles : level.shouldFailRoles;
      if (!canAct(state.seats, roles, player)) {
        throw new Error(`Claim one of these seats first: ${roles.join(", ")}.`);
      }
      const client = await this.ledger();
      const memo = (state.memos[levelId] ??= {});
      const wallet = (k: AccountKey) => {
        const a = state.accounts[k];
        if (!a) throw new Error(`world has no ${k} account; run reset-world`);
        return Wallet.fromSeed(a.seed);
      };
      const ctx: LevelContext = {
        client, cfg: this.cfg, memo, wallet,
        address: (k) => wallet(k).address,
        submit: async (k, tx) => {
          const r = await submit(client, wallet(k), tx as unknown as SubmittableTransaction);
          const who = isRole(k) && state.seats[k].player ? "human" : "bot";
          this.record(state, { ...r, level: levelId, part, note: `${k} (${who})` });
          this.log(`${r.type} by ${k}: ${r.engineResult} ${r.hash}`);
          return r;
        },
        note: (m) => this.log(m),
        record: (r, who) => {
          this.record(state, { ...r, level: levelId, part, note: who });
          this.log(`${r.type} by ${who}: ${r.engineResult} ${r.hash}`);
        },
        amendmentEnabled: (name) => this.shared.amendments?.amendments[name]?.enabled === true,
        memoOf: (id) => (state.memos[id] ??= {}),
        ensureAccount: async (k) => {
          if (!state.accounts[k]) {
            this.log(`funding ${k} from the ${this.cfg.name} faucet`);
            let w;
            try {
              w = await fundNew(client, this.cfg);
            } catch (e) {
              throw new Error(`Couldn't fund the ${k} account this level needs. ${(e as Error).message} Try the level again in a minute.`);
            }
            state.accounts[k] = { address: w.address, seed: w.seed as string };
            this.persist(state);
          }
          return state.accounts[k].address;
        },
      };
      const already = state.scores[levelId]?.[part];
      if (already) {
        return { ok: true, message: "Already cleared in this world. Reset the world to play it again.", added: 0, results: [], view: this.view(key) };
      }
      const out = await run(ctx);
      let added = 0;
      let message = out.message;
      if (part === "goal" && out.ok) {
        ({ board: state.scores, added } = award(state.scores, levelId, "goal"));
      }
      if (part === "shouldFail" && out.attempt) {
        const j = out.verdict
          ? { verdict: out.verdict.verdict, matchedExpected: true }
          : judgeShouldFail(out.attempt.engineResult, out.attempt.validated, level.expectedRejects);
        const label = out.verdict?.label ?? out.attempt.engineResult;
        if (j.verdict === "rejected") {
          ({ board: state.scores, added } = award(state.scores, levelId, "shouldFail"));
          message = `Rejected, as it should be (${label}). ${level.rejectReason}`;
          if (!j.matchedExpected && level.expectedRejects.length) message += ` Note: expected one of ${level.expectedRejects.join(", ")}.`;
        } else if (j.verdict === "accepted") {
          state.bugs.push(`${levelId}: should-fail was accepted (${out.attempt.hash})`);
          message = `Unexpected: the ledger accepted it (${label}). No points; flagged for maintainers.`;
        } else {
          message = `Inconclusive (${label}): the attempt never reached a final ledger result (network, queue or timeout). No points; try again.`;
        }
      }
      this.persist(state);
      return { ok: out.ok, message, added, results: out.results, view: this.view(key) };
    });
  }

  /**
   * Live ledger objects owned by this world's accounts (credentials, domains, vaults, loan
   * brokers, loans, offers, trust lines), for the dashboard. Read-only.
   */
  objects(key: WorldKey = null) {
    const state = this.st(key);
    return this.readGate.run(async () => {
      const client = await this.ledger();
      const out: Array<{ owner: string; type: string; id: string; detail: string }> = [];
      for (const [k, a] of Object.entries(state.accounts)) {
        const res = await client.request({ command: "account_objects", account: a.address, ledger_index: "validated", limit: 50 });
        for (const o of res.result.account_objects as unknown as Array<Record<string, unknown>>) {
          out.push({ owner: k, type: String(o.LedgerEntryType), id: String(o.index), detail: summarize(o, a.address) });
        }
      }
      return { network: this.cfg.name, world: state.world, objects: out };
    });
  }

  private record(state: WorldState, r: RecentResult) {
    state.recent.unshift(r);
    state.recent.length = Math.min(state.recent.length, RECENT_MAX);
  }
}

/** Short, secret-free description of a ledger entry for the dashboard. */
export function summarize(o: Record<string, unknown>, owner = ""): string {
  const hexText = (h: unknown) => (typeof h === "string" ? Buffer.from(h, "hex").toString("utf8") : "");
  switch (o.LedgerEntryType) {
    case "Credential": return `${hexText(o.CredentialType)} ${((o.Flags as number) & 0x10000) ? "accepted" : "not accepted"}`;
    case "PermissionedDomain": return `${(o.AcceptedCredentials as unknown[] | undefined)?.length ?? 0} accepted credential type(s)`;
    case "Vault": return `assets ${o.AssetsTotal ?? 0}, available ${o.AssetsAvailable ?? 0}`;
    case "LoanBroker": return `debt ${o.DebtTotal ?? 0} / max ${o.DebtMaximum ?? "?"}, cover ${o.CoverAvailable ?? 0}`;
    case "Loan": return `payments remaining ${o.PaymentRemaining ?? 0}`;
    case "Offer": return `${o.DomainID ? "in domain" : "open DEX"}`;
    case "RippleState": {
      // Balance is stored from the low account's view; show it from the owner's view.
      const b = o.Balance as { currency?: string; value?: string } | undefined;
      const low = (o.LowLimit as { issuer?: string } | undefined)?.issuer;
      const peer = low === owner ? (o.HighLimit as { issuer?: string } | undefined)?.issuer : low;
      const v = Number(b?.value ?? 0) * (low === owner ? 1 : -1);
      return `${b?.currency ?? ""} ${v} with ${String(peer ?? "").slice(0, 8)}…${(o.Flags as number) & 0x00400000 || (o.Flags as number) & 0x00800000 ? ", frozen" : ""}`;
    }
    default: return "";
  }
}
