import type { Client, Wallet } from "xrpl";
import type { NetworkConfig } from "../config.ts";
import type { TxResult } from "../ledger.ts";
import type { Role } from "../seats.ts";

/** Seat accounts, the holder bot, and extra accounts a level funds lazily (e.g. "clawIssuer"). */
export type AccountKey = Role | "holderBot" | "clawIssuer";

export interface LevelContext {
  client: Client;
  cfg: NetworkConfig;
  wallet: (k: AccountKey) => Wallet;
  address: (k: AccountKey) => string;
  /** Submit as an account; result is recorded on the dashboard. */
  submit: (k: AccountKey, tx: Record<string, unknown>) => Promise<TxResult>;
  note: (msg: string) => void;
  /** Record a result submitted outside ctx.submit (e.g. a co-signed Batch). */
  record: (r: TxResult, who: string) => void;
  /** Fund an extra test account from the faucet the first time a level needs it (kept for this world). */
  ensureAccount: (k: AccountKey) => Promise<string>;
  /** Memo of another level in this world (read-only use: prerequisites). */
  memoOf: (levelId: string) => Record<string, unknown>;
  /** Per-world scratch memory for this level (persisted). */
  memo: Record<string, unknown>;
}

export interface StepOutcome {
  ok: boolean;
  message: string;
  results: TxResult[];
  /** For should-fail: the engine result of the attempt that should be rejected. */
  attempt?: TxResult;
  /**
   * Optional verdict when the engine result alone can't tell (e.g. a Batch's outer tx is
   * tesSUCCESS even when its all-or-nothing inner transactions were rolled back).
   */
  verdict?: { rejected: boolean; label: string };
}

export interface LevelDef {
  id: string;
  n: number;
  title: string;
  /** Feature key from FEATURE_AMENDMENTS, or null when only core rules are needed. */
  feature: string | null;
  priority?: boolean;
  goal: string;
  shouldFail: string;
  rejectReason: string;
  expectedRejects: string[];
  goalRoles: Role[];
  shouldFailRoles: Role[];
  bots: string;
  docs: { title: string; href: string }[];
  /** Explainer levels have no ledger transactions yet (e.g. amendment still in voting). */
  explainer?: string[];
  runGoal?: (ctx: LevelContext) => Promise<StepOutcome>;
  runShouldFail?: (ctx: LevelContext) => Promise<StepOutcome>;
}
