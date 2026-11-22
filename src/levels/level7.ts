// Level 7: lending protocol. A vault owner runs a loan broker; a borrower and the broker
// co-sign a loan; the borrower repays it. Our own teaching path (ideas only from
// XRPLF XRPL-LendingReference; no code copied).
// Facts: https://xrpl.org/docs/concepts/tokens/lending-protocol
//        https://xrpl.org/docs/references/protocol/transactions/types/loanset
//        https://xrpl.org/docs/references/protocol/transactions/types/vaultcreate
//
// When LendingProtocolV1_1 is enabled, new loan brokers attach only to CLOSED-ended vaults,
// and loans can only be originated in the vault's Investment phase (after SubscriptionDate),
// with the final payment at least 60 s before RedemptionDate. The game checks the amendment
// live and builds the right kind of vault.

import { signLoanSetByCounterparty, type LoanSet } from "xrpl";
import { submitBlob, type TxResult } from "../ledger.ts";
import type { LevelContext, StepOutcome } from "./types.ts";
import { vaultNode, XRP } from "./level6.ts";
import { ledgerEntry, stepper } from "./util.ts";

const DEBT_MAX_XRP = 20;
const SUBSCRIBE_S = 30; // subscription window after creation
const TERM_S = 240; // SubscriptionDate -> RedemptionDate (minimum is 180)
const PAYMENT_INTERVAL_S = 60; // minimum allowed

async function ledgerTime(ctx: LevelContext): Promise<number> {
  const r = await ctx.client.request({ command: "ledger", ledger_index: "validated" });
  return r.result.ledger.close_time; // seconds since the Ripple Epoch
}

/** True when a new loan can be originated now (always true for open vaults). */
function inLoanWindow(m: Record<string, unknown>, now: number): boolean {
  if (typeof m.redemption !== "number" || typeof m.subscription !== "number") return true;
  return now > m.subscription && now + PAYMENT_INTERVAL_S + 60 + 15 < m.redemption;
}

/** Vault + deposit + broker + first-loss cover. Reuses the current setup if loans can still be made. */
async function ensureLending(ctx: LevelContext, results: TxResult[]): Promise<string> {
  const m = ctx.memo;
  if (typeof m.brokerId === "string" && inLoanWindow(m, await ledgerTime(ctx))) return m.brokerId;
  const step = stepper(ctx, results);
  const closed = ctx.amendmentEnabled("LendingProtocolV1_1");
  const create: Record<string, unknown> = { TransactionType: "VaultCreate", Asset: { currency: "XRP" } };
  if (closed) {
    const now = await ledgerTime(ctx);
    m.subscription = now + SUBSCRIBE_S;
    m.redemption = now + SUBSCRIBE_S + TERM_S;
    Object.assign(create, { VaultKind: 1, SubscriptionDate: m.subscription, RedemptionDate: m.redemption });
  } else {
    delete m.subscription;
    delete m.redemption;
  }
  const v = await step("lender", create, closed ? "Lender creates a closed-ended XRP vault (subscription, then investment, then redemption)" : "Lender creates an XRP vault");
  const VaultID = v.created?.Vault;
  if (!VaultID) throw new Error("no Vault in VaultCreate metadata");
  m.vaultId = VaultID;
  await step("lender", { TransactionType: "VaultDeposit", VaultID, Amount: XRP(40) }, "Lender deposits 40 XRP into its vault");
  const b = await step("lender", { TransactionType: "LoanBrokerSet", VaultID, DebtMaximum: XRP(DEBT_MAX_XRP) }, `Lender opens a loan broker (debt max ${DEBT_MAX_XRP} XRP)`);
  const brokerId = b.created?.LoanBroker;
  if (!brokerId) throw new Error("no LoanBroker in LoanBrokerSet metadata");
  await step("lender", { TransactionType: "LoanBrokerCoverDeposit", LoanBrokerID: brokerId, Amount: XRP(2) }, "Lender posts 2 XRP of first-loss capital");
  m.brokerId = brokerId;
  if (closed) {
    ctx.note("Waiting for the subscription window to close (investment phase starts)…");
    for (let i = 0; i < 30 && (await ledgerTime(ctx)) <= (m.subscription as number); i++) await new Promise((r) => setTimeout(r, 3000));
  }
  return brokerId;
}

/** LoanSet must be signed by both the broker owner (lender) and the borrower. */
async function coSignedLoan(ctx: LevelContext, brokerId: string, principalXrp: number): Promise<TxResult> {
  const lender = ctx.wallet("lender");
  const borrower = ctx.wallet("borrower");
  const tx: LoanSet = {
    TransactionType: "LoanSet",
    Account: lender.address,
    Counterparty: borrower.address,
    LoanBrokerID: brokerId,
    PrincipalRequested: XRP(principalXrp),
    PaymentTotal: 1,
    PaymentInterval: PAYMENT_INTERVAL_S,
    GracePeriod: PAYMENT_INTERVAL_S,
  };
  const warn = console.warn; // xrpl.js warns about counterparty fee estimation on every LoanSet
  console.warn = () => {};
  let prepared: LoanSet;
  try {
    prepared = (await ctx.client.autofill(tx)) as LoanSet;
  } finally {
    console.warn = warn;
  }
  const first = lender.sign(prepared);
  const both = signLoanSetByCounterparty(borrower, first.tx_blob);
  const r = await submitBlob(ctx.client, both.tx_blob, both.hash, "LoanSet", lender.address);
  ctx.record(r, "lender + borrower (co-signed)");
  return r;
}

async function runGoal(ctx: LevelContext): Promise<StepOutcome> {
  const results: TxResult[] = [];
  const step = stepper(ctx, results);
  try {
    const brokerId = await ensureLending(ctx, results);
    ctx.note("Lender and borrower co-sign a 10 XRP loan: one payment, 0% interest");
    const loan = await coSignedLoan(ctx, brokerId, 10);
    results.push(loan);
    if (loan.engineResult !== "tesSUCCESS" || !loan.created?.Loan) throw new Error(`LoanSet -> ${loan.engineResult}`);
    const LoanID = loan.created.Loan;
    const before = await ledgerEntry(ctx, { index: LoanID });
    const vault = await vaultNode(ctx, ctx.memo.vaultId as string);
    ctx.note(`Auditor: loan open, outstanding ${before?.TotalValueOutstanding ?? "?"} drops; vault available ${vault?.AssetsAvailable} drops`);
    const due = String(before?.TotalValueOutstanding ?? XRP(10));
    await step("borrower", { TransactionType: "LoanPay", LoanID, Amount: due }, `Borrower repays ${Number(due) / 1e6} XRP`);
    const after = await ledgerEntry(ctx, { index: LoanID });
    ctx.note(`Auditor: after repay, payments remaining ${after?.PaymentRemaining ?? 0}`);
    const pass = !after || Number(after.PaymentRemaining ?? 0) === 0;
    return { ok: pass, message: pass ? "Loan funded from the vault and fully repaid." : `Loan still open: ${JSON.stringify(after)}`, results };
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
}

async function runShouldFail(ctx: LevelContext): Promise<StepOutcome> {
  const results: TxResult[] = [];
  try {
    const brokerId = await ensureLending(ctx, results);
    ctx.note(`Lender and borrower try a 25 XRP loan, above the broker's ${DEBT_MAX_XRP} XRP debt maximum`);
    const attempt = await coSignedLoan(ctx, brokerId, 25);
    results.push(attempt);
    return { ok: true, message: `Ledger said ${attempt.engineResult}.`, results, attempt };
  } catch (e) {
    return { ok: false, message: (e as Error).message, results };
  }
}

export const level7Runners = { runGoal, runShouldFail };
