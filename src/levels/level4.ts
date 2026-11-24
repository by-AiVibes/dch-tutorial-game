// Level 4: Permissioned Domains. The domain lists accepted credentials; only accounts holding
// one can place offers in that domain's permissioned DEX.
// Facts: https://xrpl.org/docs/concepts/tokens/decentralized-exchange/permissioned-domains
//        https://xrpl.org/docs/concepts/tokens/decentralized-exchange/permissioned-dexes

import { CURRENCY } from "../config.ts";
import type { TxResult } from "../ledger.ts";
import type { AccountKey, LevelContext, StepOutcome } from "./types.ts";
import { KYC_TYPE } from "./level3.ts";
import { stepper } from "./util.ts";

const offer = (ctx: LevelContext, DomainID: string) => ({
  TransactionType: "OfferCreate",
  TakerGets: "1000000", // offer 1 XRP (drops)
  TakerPays: { currency: CURRENCY, issuer: ctx.address("issuer"), value: "1" },
  DomainID,
});

async function ensureDomain(ctx: LevelContext, results: TxResult[]): Promise<string> {
  if (typeof ctx.memo.domainId === "string") return ctx.memo.domainId;
  const step = stepper(ctx, results);
  const r = await step("issuer", {
    TransactionType: "PermissionedDomainSet",
    AcceptedCredentials: [{ Credential: { Issuer: ctx.address("issuer"), CredentialType: KYC_TYPE } }],
  }, "Issuer creates a domain that accepts its KYC credential");
  const id = r.created?.PermissionedDomain;
  if (!id) throw new Error("no PermissionedDomain in metadata");
  ctx.memo.domainId = id;
  return id;
}

async function tryOffer(ctx: LevelContext, who: AccountKey, DomainID: string, why: string): Promise<TxResult> {
  ctx.note(why);
  return ctx.submit(who, offer(ctx, DomainID));
}

async function runGoal(ctx: LevelContext): Promise<StepOutcome> {
  if (!ctx.memoOf("creds").goalDone) return { ok: false, message: "Clear the Level 3 goal first (the holder needs an accepted KYC credential).", results: [] };
  const results: TxResult[] = [];
  try {
    const DomainID = await ensureDomain(ctx, results);
    const r = await tryOffer(ctx, "holder", DomainID, "Credentialed holder places an offer inside the domain");
    results.push(r);
    const pass = r.engineResult === "tesSUCCESS" && !!r.created?.Offer;
    return { ok: pass, message: pass ? "The holder's offer is live in the permissioned domain." : `Offer -> ${r.engineResult}`, results };
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
}

async function runShouldFail(ctx: LevelContext): Promise<StepOutcome> {
  if (!ctx.memoOf("creds").goalDone) return { ok: false, message: "Clear the Level 3 goal first.", results: [] };
  const results: TxResult[] = [];
  try {
    const DomainID = await ensureDomain(ctx, results);
    const attempt = await tryOffer(ctx, "holderBot", DomainID, "Holder bot, without a KYC credential, tries to trade in the domain");
    results.push(attempt);
    return { ok: true, message: `Ledger said ${attempt.engineResult}.`, results, attempt };
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
}

export const level4Runners = { runGoal, runShouldFail };
