// Level 0 wallet helpers.
// The wallet is generated IN THIS BROWSER with xrpl.js. The seed stays in this module's memory
// only: it is never stored, never sent to our server, and never logged. The faucet is called
// directly from the browser with your address; our server only ever sees the address.

let wallet = null; // { address, seed } — in memory only

export const savedAddress = () => localStorage.getItem("dch-wallet-address") || "";
export const currentAddress = () => wallet?.address || savedAddress();
export const hasSeedInMemory = () => !!wallet;
/** Reveal the in-memory seed for display on this page only. */
export const revealSeed = () => wallet?.seed ?? "";

export function generateWallet() {
  if (!window.xrpl) throw new Error("Couldn't load xrpl.js in the browser.");
  const w = window.xrpl.Wallet.generate();
  wallet = { address: w.address, seed: w.seed };
  localStorage.setItem("dch-wallet-address", w.address); // the address is public; the seed is NOT stored
  return w.address;
}

/** Live balance via our server, which only ever receives the address. */
export async function balance(address = currentAddress()) {
  if (!address) return null;
  const r = await fetch(`/api/account/${encodeURIComponent(address)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `balance check failed (${r.status})`);
  return j;
}

/** Ask the public faucet (directly from the browser) to fund the address, then poll the balance. */
export async function fund(faucetHost, onProgress = () => {}) {
  const address = currentAddress();
  if (!address || !faucetHost) throw new Error("Make a wallet first.");
  const r = await fetch(`https://${faucetHost}/accounts`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ destination: address }),
  });
  if (!r.ok) throw new Error(`the faucet said ${r.status}; try again in a minute`);
  onProgress("Faucet accepted. Checking the ledger…");
  let b = null;
  for (let i = 0; i < 8; i++) {
    await new Promise((ok) => setTimeout(ok, 2500));
    b = await balance(address).catch(() => null);
    if (b?.funded) break;
  }
  return b;
}

/** Link the wallet ADDRESS to a seat in the player's own world (keyed by that address). Never the seed. */
export async function claimWithWallet(role, player) {
  const address = currentAddress();
  const r = await fetch("/api/seat/claim", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, player, wallet: address, world: address }), // never the seed
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
