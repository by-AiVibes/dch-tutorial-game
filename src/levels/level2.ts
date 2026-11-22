// Level 2: freeze a trust line, then claw back on a currency whose issuer enabled clawback.
// Facts: https://xrpl.org/docs/concepts/tokens/fungible-tokens/freezes
//        https://xrpl.org/docs/concepts/tokens/fungible-tokens/clawing-back-tokens
// Clawback must be enabled (asfAllowTrustLineClawback) while the issuer owns no ledger objects,
// so this level uses a fresh "clawIssuer" account and its own currency, CLW.

import { AccountSetAsfFlags, TrustSetFlags } from "xrpl";
import { CURRENCY } from "../config.ts";
import type { TxResult } from "../ledger.ts";
import type { LevelContext, StepOutcome } from "./types.ts";
import { stepper } from "./util.ts";

const CLW = "CLW";

async function runGoal(ctx: LevelContext): Promise<StepOutcome> {
  const results: TxResult[] = [];
  const step = stepper(ctx, results);
  try {
    const claw = await ctx.ensureAccount("clawIssuer");
    const bot = ctx.address("holderBot");
    await step("clawIssuer", { TransactionType: "AccountSet", SetFlag: AccountSetAsfFlags.asfAllowTrustLineClawback }, "Issuer enables clawback before it has any trust lines");
    await step("holderBot", { TransactionType: "TrustSet", LimitAmount: { currency: CLW, issuer: claw, value: "1000" }, Flags: TrustSetFlags.tfSetNoRipple }, "holderBot trusts the issuer for CLW");
    await step("clawIssuer", { TransactionType: "Payment", Destination: bot, Amount: { currency: CLW, issuer: claw, value: "50" } }, "Issuer sends 50 CLW to holderBot");
    ctx.note("Auditor bot flags holderBot for review");
    await step("clawIssuer", { TransactionType: "TrustSet", LimitAmount: { currency: CLW, issuer: bot, value: "0" }, Flags: TrustSetFlags.tfSetFreeze }, "Issuer freezes holderBot's CLW line");
    await step("clawIssuer", { TransactionType: "Clawback", Amount: { currency: CLW, issuer: bot, value: "50" } }, "Issuer claws back 50 CLW (Amount.issuer is the holder)");
    const lines = await ctx.client.request({ command: "account_lines", account: bot, peer: claw, ledger_index: "validated" });
    const line = lines.result.lines.find((l) => l.currency === CLW);
    const pass = !!line && line.freeze_peer === true && Number(line.balance) === 0;
    return {
      ok: pass,
      message: pass ? "Line is frozen by the issuer and the clawed-back balance is 0." : `Checks failed: line=${JSON.stringify(line ?? null)}`,
      results,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
}

async function runShouldFail(ctx: LevelContext): Promise<StepOutcome> {
  // The Level 1 issuer never enabled clawback, so its clawback must be refused.
  if (!ctx.memoOf("issue").goalDone) return { ok: false, message: "Clear the Level 1 goal first (it creates the TST lines this uses).", results: [] };
  ctx.note("Level 1 issuer (no clawback flag) tries to claw back TST from the holder");
  const attempt = await ctx.submit("issuer", { TransactionType: "Clawback", Amount: { currency: CURRENCY, issuer: ctx.address("holder"), value: "1" } });
  return { ok: true, message: `Ledger said ${attempt.engineResult}.`, results: [attempt], attempt };
}

export const level2Runners = { runGoal, runShouldFail };
