// Level 5: Batch. One outer transaction carries inner transactions from two accounts;
// in all-or-nothing mode they all apply or none do.
// Facts: https://xrpl.org/docs/concepts/transactions/batch-transactions

import { BatchFlags, GlobalFlags, signMultiBatch, type Batch } from "xrpl";
import { submitBlob, type TxResult } from "../ledger.ts";
import type { LevelContext, StepOutcome } from "./types.ts";
import { credentialAccepted } from "./level3.ts";
import { hex, ledgerEntry } from "./util.ts";

const INNER = GlobalFlags.tfInnerBatchTxn;

/** Build, co-sign (holderBot) and submit an all-or-nothing batch from the issuer. */
async function submitBatch(ctx: LevelContext, createType: string, acceptType: string): Promise<TxResult> {
  const issuer = ctx.wallet("issuer");
  const bot = ctx.wallet("holderBot");
  const batch: Batch = {
    TransactionType: "Batch",
    Account: issuer.address,
    Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: [
      { RawTransaction: { TransactionType: "CredentialCreate", Account: issuer.address, Subject: bot.address, CredentialType: createType, Flags: INNER } },
      { RawTransaction: { TransactionType: "CredentialAccept", Account: bot.address, Issuer: issuer.address, CredentialType: acceptType, Flags: INNER } },
    ],
  };
  const prepared = (await ctx.client.autofill(batch, 1)) as Batch; // 1 batch signer adds to the fee
  signMultiBatch(bot, prepared);
  const signed = issuer.sign(prepared);
  const r = await submitBlob(ctx.client, signed.tx_blob, signed.hash, "Batch", issuer.address);
  ctx.record(r, "issuer + holderBot (batch)");
  return r;
}

async function runGoal(ctx: LevelContext): Promise<StepOutcome> {
  const t = hex("DCH-BATCH");
  ctx.note("Issuer submits one batch: create a credential for holderBot AND holderBot accepts it");
  const r = await submitBatch(ctx, t, t);
  const accepted = await credentialAccepted(ctx, ctx.address("holderBot"), ctx.address("issuer"), t);
  const pass = r.engineResult === "tesSUCCESS" && accepted;
  return { ok: pass, message: pass ? "Both inner transactions applied together: the credential exists and is accepted." : `Batch ${r.engineResult}; accepted=${accepted}.`, results: [r] };
}

async function runShouldFail(ctx: LevelContext): Promise<StepOutcome> {
  // Create DCH-HALF, but accept a type that was never created. The accept can't succeed,
  // so all-or-nothing must roll back the create too.
  const half = hex("DCH-HALF");
  ctx.note("Batch where the accept can't succeed (wrong type): the create must not land either");
  const r = await submitBatch(ctx, half, hex("DCH-NONE"));
  const created = await ledgerEntry(ctx, { credential: { subject: ctx.address("holderBot"), issuer: ctx.address("issuer"), credential_type: half } });
  // Counts as a correct rejection only if the outer Batch itself was validated tesSUCCESS
  // (so the batch was really processed) AND the inner create did not land.
  const processed = r.validated && r.engineResult === "tesSUCCESS";
  const rejected = processed && created === null;
  const verdict = !processed ? "inconclusive" : rejected ? "rejected" : "accepted";
  return {
    ok: true,
    message: `Batch outer result ${r.engineResult}; half-credential on ledger: ${!rejected}.`,
    results: [r],
    attempt: r,
    verdict: { verdict, label: !processed ? `outer Batch ${r.engineResult}, not validated` : rejected ? `outer ${r.engineResult}, no inner tx applied` : "inner create applied" },
  };
}

export const level5Runners = { runGoal, runShouldFail };
