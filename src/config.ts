// Network config. Test networks only: mainnet is refused twice (by URL and by network_id).

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

const MAINNET_HINTS = [
  "xrplcluster.com",
  "s1.ripple.com",
  "s2.ripple.com",
  "xrpl.ws",
  "xrpl.link",
  "mainnet",
];

export function assertNotMainnetUrl(url: string): void {
  const u = url.toLowerCase();
  if (MAINNET_HINTS.some((h) => u.includes(h))) {
    throw new Error(`Refusing ${url}: looks like an XRPL mainnet endpoint. Test networks only.`);
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
  const name = (env.XRPL_NETWORK ?? "testnet") as NetworkName;
  const base = NETWORKS[name];
  if (!base) throw new Error(`XRPL_NETWORK must be "testnet" or "devnet", got "${name}".`);
  const ws = env.XRPL_WS || base.ws;
  assertNotMainnetUrl(ws);
  const faucetHost = env.XRPL_FAUCET_HOST || base.faucetHost;
  assertNotMainnetUrl(faucetHost);
  return { ...base, ws, faucetHost };
}

/** Where local world state lives. Holds throwaway test seeds: gitignored, mode 0600, never printed. */
export const DATA_DIR = process.env.DCH_DATA_DIR || ".data";

/** Test currency code used by Level 1. */
export const CURRENCY = "TST";
