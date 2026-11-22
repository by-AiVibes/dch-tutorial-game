// Level registry. Order and text follow the design page. Levels whose amendment is not
// enabled on the connected network show "coming soon" (checked at runtime, never assumed).

import { level1 } from "./level1.ts";
import { level2Runners } from "./level2.ts";
import { level3Runners } from "./level3.ts";
import { level4Runners } from "./level4.ts";
import { level5Runners } from "./level5.ts";
import { level6Runners } from "./level6.ts";
import { level7Runners } from "./level7.ts";
import type { LevelDef } from "./types.ts";

const planned = (d: Omit<LevelDef, "runGoal" | "runShouldFail">): LevelDef => d;
const live = (d: Omit<LevelDef, "runGoal" | "runShouldFail">, r: Pick<LevelDef, "runGoal" | "runShouldFail">): LevelDef => ({ ...d, ...r });

export const LEVELS: LevelDef[] = [
  planned({
    id: "wallet", n: 0, title: "Get your {network} wallet", feature: null,
    goal: "Learn what {network} is, create your own test wallet in this browser, fund it from the public faucet, check its balance live, and claim a seat with it.",
    shouldFail: "(Unscored onboarding level.)",
    rejectReason: "",
    expectedRejects: [],
    goalRoles: [], shouldFailRoles: [],
    bots: "Bots keep every seat until you claim one.",
    docs: [
      { title: "Parallel networks (mainnet, testnet, devnet)", href: "https://xrpl.org/docs/concepts/networks-and-servers/parallel-networks" },
      { title: "XRP faucets", href: "https://xrpl.org/resources/dev-tools/xrp-faucets" },
      { title: "Accounts", href: "https://xrpl.org/docs/concepts/accounts" },
      { title: "Reserves", href: "https://xrpl.org/docs/concepts/accounts/reserves" },
      { title: "Cryptographic keys", href: "https://xrpl.org/docs/concepts/accounts/cryptographic-keys" },
    ],
    explainer: [
      "{Network} is a public XRP Ledger test network for developers. Its XRP is free from a faucet and has no value, and the network can be reset at any time, wiping accounts.",
      "An account is created by sending it enough XRP to meet the base reserve; the faucet does that for you.",
      "Your wallet's seed is its secret key. This game makes it in your browser and never sends it to the server: only your address (r…) is shared.",
    ],
  }),
  level1,
  live({
    id: "freeze", n: 2, title: "Freeze and clawback", feature: "Clawback",
    goal: "A fresh issuer enables clawback, issues CLW to a holder bot, freezes the flagged line, then claws the CLW back.",
    shouldFail: "The Level 1 issuer, which never enabled clawback, tries to claw back TST from the holder.",
    rejectReason: "Clawback is refused unless the issuer enabled it, and only the issuer can submit it.",
    expectedRejects: ["tecNO_PERMISSION", "temMALFORMED"],
    goalRoles: ["issuer"], shouldFailRoles: ["issuer", "holder", "auditor"],
    bots: "A holder bot receives tokens. The auditor bot flags the account.",
    docs: [
      { title: "Freezing tokens", href: "https://xrpl.org/docs/concepts/tokens/fungible-tokens/freezes" },
      { title: "Clawing back tokens", href: "https://xrpl.org/docs/concepts/tokens/fungible-tokens/clawing-back-tokens" },
    ],
  }, level2Runners),
  live({
    id: "creds", n: 3, title: "Issue and accept a credential", feature: "Credentials",
    goal: "The issuer creates a credential; the holder accepts it so the credential is live.",
    shouldFail: "The holder bot tries to accept the DCH-KYC credential that was issued to the holder.",
    rejectReason: "Only the credential's subject can accept it, and it is not in force until accepted.",
    expectedRejects: ["tecNO_ENTRY", "tecNO_PERMISSION"],
    goalRoles: ["issuer", "holder"], shouldFailRoles: ["holder", "auditor"],
    bots: "The other seat is filled by a bot so create and accept can still complete.",
    docs: [{ title: "Credentials", href: "https://xrpl.org/docs/concepts/decentralized-storage/credentials" }],
  }, level3Runners),
  live({
    id: "domain", n: 4, title: "Open a permissioned domain", feature: "PermissionedDomains",
    goal: "The issuer creates a domain that accepts its DCH-KYC credential; the credentialed holder places an offer in that domain's DEX.",
    shouldFail: "The holder bot, which has no DCH-KYC credential, tries to place the same offer in the domain.",
    rejectReason: "The domain admits only accounts that hold an accepted credential it lists.",
    expectedRejects: ["tecNO_PERMISSION"],
    goalRoles: ["issuer", "holder"], shouldFailRoles: ["holder", "lender", "borrower"],
    bots: "A credentialed holder bot joins cleanly. An uncredentialed bot is refused.",
    docs: [
      { title: "Permissioned domains", href: "https://xrpl.org/docs/concepts/tokens/decentralized-exchange/permissioned-domains" },
      { title: "Permissioned DEXes", href: "https://xrpl.org/docs/concepts/tokens/decentralized-exchange/permissioned-dexes" },
    ],
  }, level4Runners),
  live({
    id: "batch", n: 5, title: "Batch: create plus accept", feature: "Batch",
    goal: "Submit one all-or-nothing batch: the issuer creates a credential and the holder bot accepts it, co-signed.",
    shouldFail: "Submit an all-or-nothing batch whose accept cannot succeed (wrong credential type).",
    rejectReason: "In all-or-nothing mode, if one inner transaction fails, none apply. The outer Batch can still be tesSUCCESS (it pays the fee), so we check that the create did not land.",
    expectedRejects: [],
    goalRoles: ["issuer", "holder"], shouldFailRoles: ["issuer", "holder"],
    bots: "The counterparty bot signs its half of the batch.",
    docs: [{ title: "Batch transactions", href: "https://xrpl.org/docs/concepts/transactions/batch-transactions" }],
  }, level5Runners),
  live({
    id: "vault", n: 6, title: "Deposit in a single-asset vault", feature: "SingleAssetVault", priority: true,
    goal: "The lender opens an XRP vault; the holder and a holder bot deposit and get shares; the holder withdraws only its own share.",
    shouldFail: "The borrower, who holds no shares, tries to withdraw from the vault.",
    rejectReason: "A vault pays out only against shares the account holds.",
    expectedRejects: ["tecINSUFFICIENT_FUNDS"],
    goalRoles: ["holder", "lender"], shouldFailRoles: ["holder", "lender", "borrower"],
    bots: "Other holder bots deposit so the vault has more than one shareholder. The auditor tracks shares.",
    docs: [
      { title: "Single asset vaults", href: "https://xrpl.org/docs/concepts/tokens/single-asset-vaults" },
      { title: "VaultWithdraw", href: "https://xrpl.org/docs/references/protocol/transactions/types/vaultwithdraw" },
      { title: "Known amendments", href: "https://xrpl.org/resources/known-amendments" },
    ],
  }, level6Runners),
  live({
    id: "lend", n: 7, title: "Fund a loan and repay it", feature: "LendingProtocol", priority: true,
    goal: "The lender funds its vault, opens a loan broker with first-loss capital, co-signs a 10 XRP loan with the borrower, and the borrower repays it.",
    shouldFail: "The borrower and lender try to open a 25 XRP loan, above the broker's 20 XRP debt maximum.",
    rejectReason: "A loan that would push the broker past its DebtMaximum is rejected.",
    expectedRejects: ["tecLIMIT_EXCEEDED"],
    goalRoles: ["lender", "borrower"], shouldFailRoles: ["borrower", "lender", "holder"],
    bots: "The other side of the loan is a bot. The auditor watches the loan object through fund, draw, and repay.",
    docs: [
      { title: "Lending protocol", href: "https://xrpl.org/docs/concepts/tokens/lending-protocol" },
      { title: "LoanSet", href: "https://xrpl.org/docs/references/protocol/transactions/types/loanset" },
      { title: "VaultCreate (closed-ended vaults)", href: "https://xrpl.org/docs/references/protocol/transactions/types/vaultcreate" },
      { title: "Known amendments", href: "https://xrpl.org/resources/known-amendments" },
    ],
  }, level7Runners),
  planned({
    id: "confidential", n: 8, title: "Explainer: confidential MPT transfers", feature: "ConfidentialTransfer", priority: true,
    goal: "Read-only explainer while the amendment is in voting: what stays public and what becomes private.",
    shouldFail: "(Interactive part arrives once the amendment is enabled on a test network.)",
    rejectReason: "",
    expectedRejects: [],
    goalRoles: [], shouldFailRoles: [],
    bots: "None yet.",
    docs: [
      { title: "Multi-purpose tokens", href: "https://xrpl.org/docs/concepts/tokens/fungible-tokens/multi-purpose-tokens" },
      { title: "ConfidentialTransfer (Known amendments)", href: "https://xrpl.org/resources/known-amendments#confidentialtransfer" },
    ],
    explainer: [
      "Multi-purpose tokens (MPTs) are a token type held directly in an account, without a trust line.",
      "ConfidentialTransfer is in amendment voting on mainnet (see the Known Amendments page). On test networks, check this game's live amendment check: as of Nov 21 2026 it was enabled on devnet.",
      "Per xrpl.org, it uses EC-ElGamal encryption and zero-knowledge proofs so individual MPT balances and transfer amounts are shielded from public view (spec: XLS-96).",
      "Compliance still works: authorized parties such as the issuer or a designated auditor can verify total supply.",
      "This level is an explainer for now; its hands-on steps are coming, and will run only where the live check shows ConfidentialTransfer enabled.",
    ],
  }),
];

/** Scored levels are the seven from the design page; Level 0 (onboarding) and the explainer are unscored. */
export const SCORED_LEVELS = LEVELS.filter((l) => l.n >= 1 && l.n <= 7);

export function findLevel(id: string): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}
