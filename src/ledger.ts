// Thin xrpl.js wrapper: connect with mainnet guards, fund from faucet, submit and report.

import { Client, Wallet, type SubmittableTransaction } from "xrpl";
import { assertTestNetworkId, type NetworkConfig } from "./config.ts";

export interface TxResult {
  hash: string;
  engineResult: string;
  validated: boolean;
  type: string;
  account: string;
  at: string;
  /** Validated ledger that included this tx, when the server reported one. */
  ledgerIndex?: number;
  /** LedgerEntryType -> index of entries this tx created (e.g. Vault, LoanBroker, Loan). */
  created?: Record<string, string>;
}

type Meta = { TransactionResult?: string; AffectedNodes?: Array<{ CreatedNode?: { LedgerEntryType: string; LedgerIndex: string } }> };

export function createdEntries(meta: Meta | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of meta?.AffectedNodes ?? []) if (n.CreatedNode) out[n.CreatedNode.LedgerEntryType] = n.CreatedNode.LedgerIndex;
  return out;
}

/** Submit an already-signed blob and normalize the result (shared by co-signed flows). */
export async function submitBlob(client: Client, blob: string, hash: string, type: string, account: string): Promise<TxResult> {
  const at = new Date().toISOString();
  try {
    const res = await client.submitAndWait(blob);
    const meta = res.result.meta as Meta | undefined;
    const ledgerIndex = typeof res.result.ledger_index === "number" ? res.result.ledger_index : undefined;
    return { hash: res.result.hash, engineResult: meta?.TransactionResult ?? "unknown", validated: res.result.validated === true, type, account, at, ...(ledgerIndex !== undefined ? { ledgerIndex } : {}), created: createdEntries(meta) };
  } catch (err) {
    // tem/tef/tel results are refused before a ledger includes them; xrpl.js throws for those.
    // Anything else here (timeout, expired LastLedgerSequence, queued) is NOT a final result:
    // it is reported as submitError / unvalidated so scoring treats it as inconclusive.
    const msg = err instanceof Error ? err.message : String(err);
    const code = /\b(te[cfmlr][A-Z_]+)\b/.exec(msg)?.[1] ?? "submitError";
    return { hash, engineResult: code, validated: false, type, account, at };
  }
}

export async function connect(cfg: NetworkConfig): Promise<Client> {
  const client = new Client(cfg.ws, { connectionTimeout: 15000 });
  await client.connect();
  const info = await client.request({ command: "server_info" });
  assertTestNetworkId(info.result.info.network_id, cfg.networkId);
  return client;
}

/** Fund a brand-new wallet from the public faucet. Seed stays in memory/state file; never logged. */
export async function fundNew(client: Client, cfg: NetworkConfig, retries = 1): Promise<Wallet> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { wallet } = await client.fundWallet(null, { faucetHost: cfg.faucetHost });
      return wallet;
    } catch (err) {
      // Public faucets rate-limit and hiccup; retry once after a pause, then give up cleanly.
      if (attempt >= retries) throw new Error(`Faucet ${cfg.faucetHost} failed: ${err instanceof Error ? err.message : err}.`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/**
 * Autofill, sign, submit and wait. Never throws on a tec/tem result: a should-fail
 * attempt *wants* a rejection, so the caller judges the engine result.
 */
export async function submit(client: Client, wallet: Wallet, tx: SubmittableTransaction): Promise<TxResult> {
  const prepared = await client.autofill({ ...tx, Account: wallet.address } as SubmittableTransaction);
  const signed = wallet.sign(prepared);
  return submitBlob(client, signed.tx_blob, signed.hash, tx.TransactionType, wallet.address);
}
