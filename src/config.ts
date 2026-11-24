// Network config. Test networks only: hosts must be on a test-host allowlist, and the
// server must report network_id 1 (testnet) or 2 (devnet); mainnet is 0.

import { join } from "node:path";

export type NetworkName = "testnet" | "devnet";

export interface NetworkConfig {
  name: NetworkName;
  /** WebSocket URL. Override with XRPL_WS (must still be a test network). */
  ws: string;
  /** Public faucet host used at runtime by reset-world. */
  faucetHost: string;
  /** Expected network_id from server_info (mainnet is 0). */
  networkId: number;
  explorer: string;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    ws: "wss://s.altnet.rippletest.net:51233",
    faucetHost: "faucet.altnet.rippletest.net",
    networkId: 1,
    explorer: "https://testnet.xrpl.org/transactions/",
  },
  devnet: {
    name: "devnet",
    ws: "wss://s.devnet.rippletest.net:51233",
    faucetHost: "faucet.devnet.rippletest.net",
    networkId: 2,
    explorer: "https://devnet.xrpl.org/transactions/",
  },
};

/** Only known public test-network hosts are allowed (WebSocket servers and faucets). */
export const ALLOWED_HOSTS = [
  "testnet.xrpl-labs.com",
  "devnet.xrpl-labs.com",
  "s.altnet.rippletest.net",
  "s.devnet.rippletest.net",
  "clio.altnet.rippletest.net",
  "clio.devnet.rippletest.net",
  "faucet.altnet.rippletest.net",
  "faucet.devnet.rippletest.net",
];

function hostOf(urlOrHost: string): string {
  try {
    return new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function assertAllowedHost(urlOrHost: string): void {
  if (!ALLOWED_HOSTS.includes(hostOf(urlOrHost))) {
    throw new Error(`Refusing ${urlOrHost}: not a known XRPL test-network host (allowed: ${ALLOWED_HOSTS.join(", ")}).`);
  }
}

export function assertTestNetworkId(id: number | undefined, expected: number): void {
  if (id === undefined || id === 0) {
    throw new Error("Refusing to run: server did not report a test network_id (mainnet is 0).");
  }
  if (id !== expected) {
    throw new Error(`Refusing to run: network_id ${id} does not match expected ${expected}.`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const name = (env.XRPL_NETWORK ?? "devnet") as NetworkName; // devnet default: every level playable (as of Nov 21 2026)
  const base = NETWORKS[name];
  if (!base) throw new Error(`XRPL_NETWORK must be "testnet" or "devnet", got "${name}".`);
  const ws = env.XRPL_WS || base.ws;
  assertAllowedHost(ws);
  const faucetHost = env.XRPL_FAUCET_HOST || base.faucetHost;
  assertAllowedHost(faucetHost);
  return { ...base, ws, faucetHost };
}

/** Where local world state lives. Override with DCH_DATA_DIR. Holds throwaway test seeds: gitignored, mode 0600, never printed. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DCH_DATA_DIR || ".data";
}

/** The stats file next to the worlds: $DCH_DATA_DIR/stats.json (default `.data/stats.json`). */
export function statsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "stats.json");
}

export const DATA_DIR = dataDir();

/** Test currency code used by Level 1. */
export const CURRENCY = "TST";
