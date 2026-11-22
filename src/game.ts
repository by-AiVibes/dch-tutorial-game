// Game engine: one world per network, serialized operations, seats, levels, scoring.

import { Wallet, type Client, type SubmittableTransaction } from "xrpl";
import { checkAmendments, featureEnabled } from "./amendments.ts";
import type { NetworkConfig } from "./config.ts";
import { connect, fundNew, submit } from "./ledger.ts";
import { findLevel, LEVELS, SCORED_LEVELS } from "./levels/index.ts";
import type { AccountKey, LevelContext } from "./levels/types.ts";
import { award, judgeShouldFail, MAX_SCORE, total, type Part } from "./scoring.ts";
import { botSeats, canAct, claimSeat, isRole, releaseSeat, ROLES } from "./seats.ts";
import { load, publicView, save, type RecentResult, type WorldState } from "./store.ts";

/** Accounts funded per world: the five role seats plus one holder bot. */
export const WORLD_ACCOUNTS: AccountKey[] = [...ROLES, "holderBot"];
const RECENT_MAX = 50;

export class Game {
  private state: WorldState;
  private queue: Promise<unknown> = Promise.resolve();
  private client: Client | null = null;
  readonly cfg: NetworkConfig;
  log: (msg: string) => void;

  constructor(cfg: NetworkConfig, log: (msg: string) => void = () => {}) {
    this.cfg = cfg;
    this.log = log;
    this.state = load(cfg.name);
  }

  /** Serialize every mutating operation so concurrent requests can't interleave ledger steps. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ledger(): Promise<Client> {
    if (this.client?.isConnected()) return this.client;
    this.client = await connect(this.cfg);
    return this.client;
  }

  async close(): Promise<void> {
    if (this.client?.isConnected()) await this.client.disconnect();
  }

  view() {
    const levels = LEVELS.map((l) => ({
      id: l.id, n: l.n, title: l.title, feature: l.feature, priority: !!l.priority,
      goal: l.goal, shouldFail: l.shouldFail, rejectReason: l.rejectReason, bots: l.bots,
      goalRoles: l.goalRoles, shouldFailRoles: l.shouldFailRoles, docs: l.docs, explainer: l.explainer ?? null,
      available: this.levelAvailable(l.id),
      playable: !!l.runGoal && this.levelAvailable(l.id),
      score: this.state.scores[l.id] ?? { goal: false, shouldFail: false },
    }));
    return {
      ...publicView(this.state),
      network: this.cfg.name,
      explorer: this.cfg.explorer,
      score: total(this.state.scores),
      maxScore: MAX_SCORE,
      scoredLevels: SCORED_LEVELS.length,
      levels,
    };
  }

  levelAvailable(id: string): boolean {
    const l = findLevel(id);
    if (!l) return false;
    if (l.feature === null) return true;
    return featureEnabled(this.state.amendments, l.feature);
  }

  claim(role: string, player: string) {
    if (!isRole(role)) throw new Error("unknown role");
    this.state.seats = claimSeat(this.state.seats, role, player);
    save(this.state);
    return this.view();
  }

  release(role: string, player: string) {
    if (!isRole(role)) throw new Error("unknown role");
    this.state.seats = releaseSeat(this.state.seats, role, player);
    save(this.state);
    return this.view();
  }

  refreshAmendments() {
    return this.exclusive(async () => {
      this.state.amendments = await checkAmendments(await this.ledger(), this.cfg.name);
      save(this.state);
      return this.state.amendments;
    });
  }

  /**
   * reset-world: fund a fresh set of faucet accounts, seat bots in every role, clear scores,
   * memos and recent results, and re-check amendments. Idempotent: every run ends in the same
   * clean shape. State is only replaced after all funding succeeds, so a failed run leaves the
   * previous world intact and can simply be re-run. Old test accounts are abandoned on the test
   * network (nothing of value; test networks are reset periodically).
   */
  resetWorld() {
    return this.exclusive(async () => {
      const client = await this.ledger();
      const accounts: WorldState["accounts"] = {};
      for (const k of WORLD_ACCOUNTS) {
        this.log(`funding ${k} from the ${this.cfg.name} faucet`);
        const w = await fundNew(client, this.cfg);
        accounts[k] = { address: w.address, seed: w.seed as string };
      }
      const amendments = await checkAmendments(client, this.cfg.name);
      this.state = {
        ...this.state,
        world: this.state.world + 1,
        createdAt: new Date().toISOString(),
        accounts,
        seats: botSeats(),
        scores: {},
        memos: {},
        recent: [],
        bugs: [],
        amendments,
      };
      save(this.state);
      this.log(`world ${this.state.world} ready on ${this.cfg.name}`);
      return this.view();
    });
  }

  play(levelId: string, part: Part, player: string | null) {
    return this.exclusive(async () => {
      const level = findLevel(levelId);
      if (!level) throw new Error("unknown level");
      if (!this.levelAvailable(levelId)) {
        return { ok: false, comingSoon: true, message: `Coming soon: ${level.feature} is not enabled on ${this.cfg.name} yet.`, added: 0, view: this.view() };
      }
      const run = part === "goal" ? level.runGoal : level.runShouldFail;
      if (!run) return { ok: false, comingSoon: true, message: "This level's interactive steps are coming in a later slice.", added: 0, view: this.view() };
      if (!this.state.world) throw new Error("No world yet. Run reset-world first.");
      const roles = part === "goal" ? level.goalRoles : level.shouldFailRoles;
      if (!canAct(this.state.seats, roles, player)) {
        throw new Error(`Claim one of these seats first: ${roles.join(", ")}.`);
      }
      const client = await this.ledger();
      const memo = (this.state.memos[levelId] ??= {});
      const wallet = (k: AccountKey) => {
        const a = this.state.accounts[k];
        if (!a) throw new Error(`world has no ${k} account; run reset-world`);
        return Wallet.fromSeed(a.seed);
      };
      const ctx: LevelContext = {
        client, cfg: this.cfg, memo, wallet,
        address: (k) => wallet(k).address,
        submit: async (k, tx) => {
          const r = await submit(client, wallet(k), tx as unknown as SubmittableTransaction);
          const who = isRole(k) && this.state.seats[k].player ? "human" : "bot";
          this.record({ ...r, level: levelId, part, note: `${k} (${who})` });
          this.log(`${r.type} by ${k}: ${r.engineResult} ${r.hash}`);
          return r;
        },
        note: (m) => this.log(m),
        record: (r, who) => {
          this.record({ ...r, level: levelId, part, note: who });
          this.log(`${r.type} by ${who}: ${r.engineResult} ${r.hash}`);
        },
        amendmentEnabled: (name) => this.state.amendments?.amendments[name]?.enabled === true,
        memoOf: (id) => (this.state.memos[id] ??= {}),
        ensureAccount: async (k) => {
          if (!this.state.accounts[k]) {
            this.log(`funding ${k} from the ${this.cfg.name} faucet`);
            const w = await fundNew(client, this.cfg);
            this.state.accounts[k] = { address: w.address, seed: w.seed as string };
            save(this.state);
          }
          return this.state.accounts[k].address;
        },
      };
      const already = this.state.scores[levelId]?.[part];
      if (already) {
        return { ok: true, message: "Already cleared in this world. Reset the world to play it again.", added: 0, results: [], view: this.view() };
      }
      const out = await run(ctx);
      let added = 0;
      let message = out.message;
      if (part === "goal" && out.ok) {
        ({ board: this.state.scores, added } = award(this.state.scores, levelId, "goal"));
      }
      if (part === "shouldFail" && out.attempt) {
        const j = out.verdict
          ? { rejected: out.verdict.rejected, matchedExpected: true, bug: !out.verdict.rejected }
          : judgeShouldFail(out.attempt.engineResult, level.expectedRejects);
        const label = out.verdict?.label ?? out.attempt.engineResult;
        if (j.rejected) {
          ({ board: this.state.scores, added } = award(this.state.scores, levelId, "shouldFail"));
          message = `Rejected, as it should be (${label}). ${level.rejectReason}`;
          if (!j.matchedExpected) message += ` Note: expected one of ${level.expectedRejects.join(", ")}.`;
        } else {
          this.state.bugs.push(`${levelId}: should-fail was accepted (${out.attempt.hash})`);
          message = `Unexpected: the ledger accepted it (${label}). No points; flagged for maintainers.`;
        }
      }
      save(this.state);
      return { ok: out.ok, message, added, results: out.results, view: this.view() };
    });
  }

  private record(r: RecentResult) {
    this.state.recent.unshift(r);
    this.state.recent.length = Math.min(this.state.recent.length, RECENT_MAX);
  }
}
