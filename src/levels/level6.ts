// Level 6: single-asset vault. Depositors get shares; a withdrawal can't exceed your shares.
// Facts: https://xrpl.org/docs/concepts/tokens/single-asset-vaults
//        https://xrpl.org/docs/references/protocol/transactions/types/vaultwithdraw
// The vault holds XRP so no trust lines are needed; amounts are in drops.

import type { TxResult } from "../ledger.ts";
import type { AccountKey, LevelContext, StepOutcome } from "./types.ts";
import { ledgerEntry, stepper } from "./util.ts";

export const XRP = (xrp: number) => String(Math.round(xrp * 1_000_000));

/** Creates a vault owned by `owner` once per world/level and remembers its ID in the memo. */
export async function ensureVault(ctx: LevelContext, owner: AccountKey, results: TxResult[]): Promise<string> {
  if (typeof ctx.memo.vaultId === "string") return ctx.memo.vaultId;
  const step = stepper(ctx, results);
  const r = await step(owner, { TransactionType: "VaultCreate", Asset: { currency: "XRP" } }, `${owner} creates an XRP vault`);
  const id = r.created?.Vault;
  if (!id) throw new Error("VaultCreate succeeded but no Vault entry was found in metadata");
  ctx.memo.vaultId = id;
  return id;
}

export async function vaultNode(ctx: LevelContext, id: string) {
  return ledgerEntry(ctx, { index: id });
}

async function runGoal(ctx: LevelContext): Promise<StepOutcome> {
  const results: TxResult[] = [];
  const step = stepper(ctx, results);
  try {
    const VaultID = await ensureVault(ctx, "lender", results);
    await step("holder", { TransactionType: "VaultDeposit", VaultID, Amount: XRP(10) }, "Holder deposits 10 XRP and receives vault shares");
    await step("holderBot", { TransactionType: "VaultDeposit", VaultID, Amount: XRP(5) }, "Holder bot deposits 5 XRP (a second shareholder)");
    await step("holder", { TransactionType: "VaultWithdraw", VaultID, Amount: XRP(10) }, "Holder withdraws its 10 XRP share");
    const v = await vaultNode(ctx, VaultID);
    ctx.note(`Auditor: vault AssetsTotal=${v?.AssetsTotal} AssetsAvailable=${v?.AssetsAvailable}`);
    const pass = String(v?.AssetsTotal) === XRP(5);
    return { ok: pass, message: pass ? "Holder got its share back; the holder bot's 5 XRP is still in the vault." : `Unexpected vault totals: ${JSON.stringify({ total: v?.AssetsTotal, available: v?.AssetsAvailable })}`, results };
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
}

async function runShouldFail(ctx: LevelContext): Promise<StepOutcome> {
  const results: TxResult[] = [];
  try {
    const VaultID = await ensureVault(ctx, "lender", results);
    ctx.note("Borrower, who never deposited, tries to withdraw 1 XRP from the vault");
    const attempt = await ctx.submit("borrower", { TransactionType: "VaultWithdraw", VaultID, Amount: XRP(1) });
    results.push(attempt);
    return { ok: true, message: `Ledger said ${attempt.engineResult}.`, results, attempt };
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
}

export const level6Runners = { runGoal, runShouldFail };
