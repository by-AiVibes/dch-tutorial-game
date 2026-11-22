import type { Client, Wallet } from "xrpl";
import type { NetworkConfig } from "../config.ts";
import type { TxResult } from "../ledger.ts";
import type { Role } from "../seats.ts";

export type AccountKey = Role | "holderBot";

export interface LevelContext {
  client: Client;
  cfg: NetworkConfig;
  wallet: (k: AccountKey) => Wallet;
  address: (k: AccountKey) => string;
  /** Submit as an account; result is recorded on the dashboard. */
  submit: (k: AccountKey, tx: Record<string, unknown>) => Promise<TxResult>;
  note: (msg: string) => void;
  /** Per-world scratch memory for this level (persisted). */
  memo: Record<string, unknown>;
}

export interface StepOutcome {
  ok: boolean;
  message: string;
  results: TxResult[];
  /** For should-fail: the engine result of the attempt that should be rejected. */
  attempt?: TxResult;
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
