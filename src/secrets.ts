// Guards so a player's seed can never reach (or be logged by) the server.
// Level 0 creates wallets in the browser; only the public address is ever sent.

import { isValidClassicAddress } from "xrpl";

const B58 = "1-9A-HJ-NP-Za-km-z";
/**
 * Secret shapes refused anywhere inside a value (addresses, which start with r, never match):
 * - a family seed (s + 24–34 base58 chars), even embedded in other text
 * - a hex run of 32+ chars (32-hex entropy, 64-hex private keys, 66-hex keys)
 * - 12+ lowercase words in a row (a mnemonic phrase)
 * - XRPL secret numbers: 8 groups of 6 digits
 */
const SECRET_PATTERNS: RegExp[] = [
  new RegExp(`(^|[^${B58}])s[${B58}]{24,34}(?![${B58}])`),
  /[0-9A-Fa-f]{32,}/,
  /\b[a-z]+(?:[\s,]+[a-z]+){11,}\b/,
  /\b\d{6}(?:[\s-]+\d{6}){7}\b/,
];
const SECRET_KEYS = /seed|secret|private|mnemonic|passphrase|entropy/i;

export function looksSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value));
}

/** Throws if any key or string value in a request body looks like a secret. Never echoes the value. */
export function assertNoSecrets(body: unknown): void {
  if (typeof body === "string") {
    if (looksSecret(body)) throw new SecretRejected();
    return;
  }
  if (Array.isArray(body)) return body.forEach((v) => assertNoSecrets(v));
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body)) {
      if (SECRET_KEYS.test(k) || looksSecret(k)) throw new SecretRejected();
      assertNoSecrets(v);
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
