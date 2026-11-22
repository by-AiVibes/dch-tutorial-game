// World state on disk. The file holds throwaway faucet seeds, so it is gitignored,
// written with mode 0600, and never returned by the API or printed.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
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
  /** Per-player worlds: the player's classic address (public). Absent for the shared world. */
  owner?: string | null;
}

export function emptyWorld(network: string): WorldState {
  return { version: 1, network, world: 0, createdAt: null, accounts: {}, seats: botSeats(), scores: {}, memos: {}, recent: [], bugs: [], amendments: null };
}

/** A per-player world key is a classic address: base58 only, so it is filename-safe. */
const OWNER_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const NET_RE = /^[a-z]{1,16}$/;

export function playersDir(): string {
  return join(DATA_DIR, "players");
}

/** Path of a world file. owner = validated classic address for a per-player world, else the shared world. */
export function statePath(network: string, owner: string | null = null): string {
  if (!NET_RE.test(network)) throw new Error("bad network name");
  if (owner === null) return join(DATA_DIR, `world-${network}.json`);
  if (!OWNER_RE.test(owner)) throw new Error("bad world key"); // defense in depth; callers validate with cleanAddress
  return join(playersDir(), `${network}-${owner}.json`);
}

export function load(network: string, owner: string | null = null): WorldState {
  const p = statePath(network, owner);
  if (!existsSync(p)) return { ...emptyWorld(network), ...(owner ? { owner } : {}) };
  return JSON.parse(readFileSync(p, "utf8")) as WorldState;
}

export function worldExists(network: string, owner: string): boolean {
  return existsSync(statePath(network, owner));
}

/** Stored per-player worlds for a network, with their last-write time (used for LRU). */
export function listPlayerWorlds(network: string): Array<{ owner: string; mtimeMs: number }> {
  const dir = playersDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ owner: string; mtimeMs: number }> = [];
  for (const f of readdirSync(dir)) {
    const m = /^([a-z]+)-(r[1-9A-HJ-NP-Za-km-z]{24,34})\.json$/.exec(f);
    if (!m || m[1] !== network) continue;
    out.push({ owner: m[2], mtimeMs: statSync(join(dir, f)).mtimeMs });
  }
  return out;
}

export function deleteWorld(network: string, owner: string): void {
  rmSync(statePath(network, owner), { force: true });
}

/** Atomic write (tmp + rename) so a crash mid-write can't corrupt the world. */
export function save(state: WorldState): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (state.owner) mkdirSync(playersDir(), { recursive: true, mode: 0o700 });
  const p = statePath(state.network, state.owner ?? null);
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
