// World state on disk. The file holds throwaway faucet seeds, so it is gitignored,
// written with mode 0600, and never returned by the API or printed.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { AmendmentReport } from "./amendments.ts";
import type { TxResult } from "./ledger.ts";
import type { Scoreboard } from "./scoring.ts";
import { botSeats, type Seats } from "./seats.ts";

export interface StoredAccount {
  address: string;
  /** Test-network seed. Secret: never log, never send to the browser. */
  seed: string;
}

export interface RecentResult extends TxResult {
  level?: string;
  part?: string;
  note?: string;
}

export interface WorldState {
  version: 1;
  network: string;
  world: number;
  createdAt: string | null;
  accounts: Record<string, StoredAccount>;
  seats: Seats;
  scores: Scoreboard;
  memos: Record<string, Record<string, unknown>>;
  recent: RecentResult[];
  bugs: string[];
  amendments: AmendmentReport | null;
}

export function emptyWorld(network: string): WorldState {
  return { version: 1, network, world: 0, createdAt: null, accounts: {}, seats: botSeats(), scores: {}, memos: {}, recent: [], bugs: [], amendments: null };
}

export function statePath(network: string): string {
  return join(DATA_DIR, `world-${network}.json`);
}

export function load(network: string): WorldState {
  const p = statePath(network);
  if (!existsSync(p)) return emptyWorld(network);
  return JSON.parse(readFileSync(p, "utf8")) as WorldState;
}

/** Atomic write (tmp + rename) so a crash mid-write can't corrupt the world. */
export function save(state: WorldState): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const p = statePath(state.network);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

/** Public view: addresses only, no seeds. */
export function publicView(state: WorldState) {
  const { accounts, ...rest } = state;
  return {
    ...rest,
    accounts: Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, { address: a.address }])),
  };
}
