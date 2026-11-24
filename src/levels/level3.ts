// Level 3: issue and accept a credential.
// Facts: https://xrpl.org/docs/concepts/decentralized-storage/credentials

import type { TxResult } from "../ledger.ts";
import type { LevelContext, StepOutcome } from "./types.ts";
import { hex, ledgerEntry, stepper } from "./util.ts";

export const KYC_TYPE = hex("KYC");
const LSF_ACCEPTED = 0x00010000;

export async function credentialAccepted(ctx: LevelContext, subject: string, issuer: string, type: string): Promise<boolean> {
  const node = await ledgerEntry(ctx, { credential: { subject, issuer, credential_type: type } });
  return !!node && ((node.Flags as number) & LSF_ACCEPTED) !== 0;
}

async function runGoal(ctx: LevelContext): Promise<StepOutcome> {
  const results: TxResult[] = [];
  const step = stepper(ctx, results);
  const issuer = ctx.address("issuer");
  const holder = ctx.address("holder");
  try {
    await step("issuer", { TransactionType: "CredentialCreate", Subject: holder, CredentialType: KYC_TYPE }, "Issuer creates a KYC credential for the holder");
    ctx.note("Auditor checks: credential exists but is not in force until accepted");
    const before = await credentialAccepted(ctx, holder, issuer, KYC_TYPE);
    await step("holder", { TransactionType: "CredentialAccept", Issuer: issuer, CredentialType: KYC_TYPE }, "Holder accepts the credential");
    const after = await credentialAccepted(ctx, holder, issuer, KYC_TYPE);
    const pass = !before && after;
    ctx.memo.goalDone = pass;
    return { ok: pass, message: pass ? "Credential went from created (not accepted) to accepted." : `Checks failed: accepted before=${before}, after=${after}.`, results };
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
}

async function runShouldFail(ctx: LevelContext): Promise<StepOutcome> {
  // holderBot tries to accept a KYC credential that was issued to someone else.
  ctx.note("holderBot tries to accept a credential that was not issued to it");
  const attempt = await ctx.submit("holderBot", { TransactionType: "CredentialAccept", Issuer: ctx.address("issuer"), CredentialType: KYC_TYPE });
  return { ok: true, message: `Ledger said ${attempt.engineResult}.`, results: [attempt], attempt };
}

export const level3Runners = { runGoal, runShouldFail };
