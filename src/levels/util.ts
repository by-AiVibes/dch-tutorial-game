import { convertStringToHex } from "xrpl";
import type { TxResult } from "../ledger.ts";
import type { AccountKey, LevelContext } from "./types.ts";

export const isOk = (r: TxResult) => r.engineResult === "tesSUCCESS";
export const hex = (s: string) => convertStringToHex(s);

/** Runs happy-path steps in order; throws on the first non-tesSUCCESS so the goal reports where it stopped. */
export function stepper(ctx: LevelContext, results: TxResult[]) {
  return async (k: AccountKey, tx: Record<string, unknown>, why: string): Promise<TxResult> => {
    ctx.note(why);
    const r = await ctx.submit(k, tx);
    results.push(r);
    if (!isOk(r)) throw new Error(`${why} -> ${r.engineResult}`);
    return r;
  };
}

export async function ledgerEntry(ctx: LevelContext, req: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = (await ctx.client.request({ command: "ledger_entry", ledger_index: "validated", ...req } as never)) as { result: { node: Record<string, unknown> } };
    return res.result.node;
  } catch {
    return null; // entryNotFound
  }
}
