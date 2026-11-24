// What a live run may send to the browser. Built by copying an allowlist, never by
// stripping a denylist: a seed, secret, mnemonic, or signed blob that isn't named here
// cannot ride along, even when the level that produced the step had one in scope.

import { looksSecret } from "./secrets.ts";

/** Ripple epoch (2000-01-01T00:00:00Z), used to turn ledger_time into an ISO close time. */
export const RIPPLE_EPOCH_SEC = 946684800;

/** Fields a run-log event is allowed to carry. Anything else is dropped. */
export const RUN_FIELDS = ["label", "type", "engineResult", "hash", "validated", "ledgerIndex"] as const;

/** A ledger tick is only the index and the close time. Nothing else from the stream. */
export const LEDGER_FIELDS = ["ledgerIndex", "closeTime"] as const;

const HASH_RE = /^[A-F0-9]{64}$/i;
const ENGINE_RE = /^(?:te[a-z][A-Za-z0-9_]{0,40}|submitError|unknown)$/;
const TYPE_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const SECRET_KEY = /seed|secret|private|mnemonic|passphrase|entropy|blob/i;

export interface RunEvent {
  label?: string;
  type?: string;
  engineResult?: string;
  hash?: string;
  validated?: boolean;
  ledgerIndex?: number;
}

export interface LedgerEvent {
  ledgerIndex: number;
  closeTime: string;
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  // Check the whole string before slicing, so a seed can't hide by being cut in half.
  if (!text || looksSecret(text)) return undefined;
  return text.slice(0, 160);
}

/** Copy only RUN_FIELDS off an arbitrary step payload. Returns null when nothing safe remains. */
export function projectRunEvent(raw: unknown): RunEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: RunEvent = {};
  const label = cleanLabel(src.label);
  if (label) out.label = label;
  if (typeof src.type === "string" && TYPE_RE.test(src.type) && !looksSecret(src.type)) out.type = src.type;
  if (typeof src.engineResult === "string" && ENGINE_RE.test(src.engineResult)) out.engineResult = src.engineResult;
  if (typeof src.hash === "string" && HASH_RE.test(src.hash)) out.hash = src.hash.toUpperCase();
  if (typeof src.validated === "boolean") out.validated = src.validated;
  if (typeof src.ledgerIndex === "number" && Number.isInteger(src.ledgerIndex) && src.ledgerIndex > 0 && src.ledgerIndex < 1e12) {
    out.ledgerIndex = src.ledgerIndex;
  }
  if (!out.label && !out.hash) return null;
  return streamUnsafe(out) ? null : out;
}

/**
 * A validated-ledger close, reduced to index + close time.
 * Reads only ledger_index and ledger_time (Ripple epoch seconds) and builds a fresh object.
 */
export function projectLedger(raw: unknown): LedgerEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const index = src.ledger_index;
  const time = src.ledger_time;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > 10_000_000_000) return null;
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 10_000_000_000) return null;
  const closeTime = new Date((time + RIPPLE_EPOCH_SEC) * 1000).toISOString();
  const out = { ledgerIndex: index, closeTime };
  return streamUnsafe(out) ? null : out;
}

/**
 * True when a value already shaped for the wire still looks like a secret.
 * The hash field is the one allowed 64-hex string (a transaction id). Every other
 * string is checked with the same secret patterns as inbound requests, and a key
 * named seed / secret / private / mnemonic / blob fails on its own.
 */
export function streamUnsafe(value: unknown): boolean {
  const walk = (v: unknown, key: string): boolean => {
    if (key && SECRET_KEY.test(key)) return true;
    if (typeof v === "string") {
      if (key === "hash") return !HASH_RE.test(v);
      return looksSecret(v);
    }
    if (typeof v === "number" || typeof v === "boolean" || v == null) return false;
    if (Array.isArray(v)) return v.some((item, i) => walk(item, String(i)));
    if (typeof v === "object") return Object.entries(v).some(([k, item]) => walk(item, k));
    return true;
  };
  return walk(value, "");
}
