// Guards so a player's seed can never reach (or be logged by) the server.
// Level 0 creates wallets in the browser; only the public address is ever sent.

import { isValidClassicAddress } from "xrpl";

/** Family seeds (s…) and secret-ish key names. Addresses start with r, so they never match. */
const SEED_LIKE = /^s[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const SECRET_KEYS = /seed|secret|private|mnemonic|passphrase/i;

/** Throws if any key or string value in a request body looks like a secret. Never echoes the value. */
export function assertNoSecrets(body: unknown, path = "body"): void {
  if (typeof body === "string") {
    if (SEED_LIKE.test(body.trim())) throw new SecretRejected();
    return;
  }
  if (Array.isArray(body)) return body.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body)) {
      if (SECRET_KEYS.test(k)) throw new SecretRejected();
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

export class SecretRejected extends Error {
  constructor() {
    super("Refused: never send a seed or secret to the server. Only your public address (r…) is needed.");
  }
}

export function cleanAddress(a: unknown): string {
  if (typeof a !== "string" || !isValidClassicAddress(a.trim())) throw new Error("wallet must be a classic XRPL address (r…)");
  return a.trim();
}
