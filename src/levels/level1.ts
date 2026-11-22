// Level 1: issue a token and keep rippling OFF on holder wallets.
// Facts: https://xrpl.org/docs/concepts/tokens/fungible-tokens/rippling
//        https://xrpl.org/docs/tutorials/how-tos/use-tokens/issue-a-fungible-token

import { AccountSetAsfFlags, TrustSetFlags } from "xrpl";
import { CURRENCY } from "../config.ts";
import type { LevelContext, LevelDef, StepOutcome } from "./types.ts";
import type { TxResult } from "../ledger.ts";
import { isOk } from "./util.ts";

const ok = isOk; // validated tesSUCCESS
const iou = (issuer: string, value: string) => ({ currency: CURRENCY, issuer, value });

async function lineNoRipple(ctx: LevelContext, account: string, peer: string): Promise<boolean | null> {
  const res = await ctx.client.request({ command: "account_lines", account, peer, ledger_index: "validated" });
  const line = res.result.lines.find((l) => l.currency === CURRENCY);
  return line ? line.no_ripple === true : null;
}

async function issuerHasDefaultRipple(ctx: LevelContext): Promise<boolean> {
  const res = await ctx.client.request({ command: "account_info", account: ctx.address("issuer"), ledger_index: "validated" });
  const flags = (res.result.account_flags ?? {}) as { defaultRipple?: boolean };
  return flags.defaultRipple === true;
}

async function runGoal(ctx: LevelContext): Promise<StepOutcome> {
  const results: TxResult[] = [];
  const step = async (k: Parameters<LevelContext["submit"]>[0], tx: Record<string, unknown>, why: string) => {
    ctx.note(why);
    const r = await ctx.submit(k, tx);
    results.push(r);
    if (!ok(r)) throw new Error(`${why} -> ${r.engineResult}`);
  };
  const issuer = ctx.address("issuer");
  try {
    // 1. DefaultRipple goes on the ISSUER only, so its tokens can move between holders.
    await step("issuer", { TransactionType: "AccountSet", SetFlag: AccountSetAsfFlags.asfDefaultRipple }, "Issuer turns on DefaultRipple");
    // 2. Holders trust the issuer and set NoRipple on their own side of the line.
    for (const k of ["holder", "holderBot"] as const) {
      await step(k, { TransactionType: "TrustSet", LimitAmount: iou(issuer, "1000"), Flags: TrustSetFlags.tfSetNoRipple }, `${k} opens a ${CURRENCY} trust line with NoRipple`);
    }
    // 3. Issuer issues tokens.
    for (const k of ["holder", "holderBot"] as const) {
      await step("issuer", { TransactionType: "Payment", Destination: ctx.address(k), Amount: iou(issuer, "100") }, `Issuer sends 100 ${CURRENCY} to ${k}`);
    }
    // 4. Holder to holder works: value ripples through the issuer, which allows it.
    await step("holder", { TransactionType: "Payment", Destination: ctx.address("holderBot"), Amount: iou(issuer, "10") }, `holder pays holderBot 10 ${CURRENCY} through the issuer`);
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
  const dr = await issuerHasDefaultRipple(ctx);
  const nr = await lineNoRipple(ctx, ctx.address("holder"), issuer);
  const pass = dr && nr === true;
  ctx.memo.goalDone = pass;
  return {
    ok: pass,
    message: pass
      ? `Issuer has DefaultRipple; holder line has NoRipple. Holder-to-holder payment went through the issuer.`
      : `Checks failed: issuer DefaultRipple=${dr}, holder NoRipple=${nr}.`,
    results,
  };
}

async function runShouldFail(ctx: LevelContext): Promise<StepOutcome> {
  const results: TxResult[] = [];
  if (!ctx.memo.goalDone) return { ok: false, message: "Clear the Level 1 goal first in this world.", results };
  const issuer = ctx.address("issuer");
  const holder = ctx.address("holder");
  // Setup: holderBot also trusts the HOLDER for TST, so the holder now sits between two lines.
  ctx.note("holderBot trusts holder for TST (a second line through the holder)");
  const t = await ctx.submit("holderBot", { TransactionType: "TrustSet", LimitAmount: iou(holder, "100"), Flags: TrustSetFlags.tfSetNoRipple });
  results.push(t);
  if (!ok(t)) return { ok: false, message: `Setup failed: ${t.engineResult}`, results };
  // Holder makes sure its side of that new line is NoRipple too (it is by default, as holder has no DefaultRipple).
  const s = await ctx.submit("holder", { TransactionType: "TrustSet", LimitAmount: { currency: CURRENCY, issuer: ctx.address("holderBot"), value: "0" }, Flags: TrustSetFlags.tfSetNoRipple });
  results.push(s);
  // The attempt: issuer pays holderBot "holder-issued TST", which can only arrive by rippling
  // issuer TST through the holder's two lines. NoRipple on both of the holder's lines blocks it.
  ctx.note("Issuer tries to route a payment THROUGH the holder (should be rejected)");
  const attempt = await ctx.submit("issuer", {
    TransactionType: "Payment",
    Destination: ctx.address("holderBot"),
    Amount: iou(holder, "5"),
    SendMax: iou(issuer, "5"),
  });
  results.push(attempt);
  return { ok: true, message: `Ledger said ${attempt.engineResult}.`, results, attempt };
}

export const level1: LevelDef = {
  id: "issue",
  n: 1,
  title: "Issue a token, keep rippling off",
  feature: null,
  goal: "As the issuer, turn on DefaultRipple, have holders open NoRipple trust lines, issue TST, and move it holder-to-holder through the issuer.",
  shouldFail: "Route a payment through a non-issuer holder as if rippling were on.",
  rejectReason: "A payment cannot ripple through a wallet whose trust lines have NoRipple set; the path is dry.",
  expectedRejects: ["tecPATH_DRY", "tecPATH_PARTIAL"],
  goalRoles: ["issuer", "holder"],
  shouldFailRoles: ["issuer", "holder"],
  bots: "Holder bots open trust lines and try to hop value through each other.",
  docs: [
    { title: "Rippling", href: "https://xrpl.org/docs/concepts/tokens/fungible-tokens/rippling" },
    { title: "Issue a fungible token", href: "https://xrpl.org/docs/tutorials/how-tos/use-tokens/issue-a-fungible-token" },
    { title: "Trust lines and issuing", href: "https://xrpl.org/docs/concepts/tokens/fungible-tokens" },
  ],
  runGoal,
  runShouldFail,
};
