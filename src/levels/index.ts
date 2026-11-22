// Level registry. Order and text follow the design page. Levels whose amendment is not
// enabled on the connected network show "coming soon" (checked at runtime, never assumed).

import { level1 } from "./level1.ts";
import type { LevelDef } from "./types.ts";

const planned = (d: Omit<LevelDef, "runGoal" | "runShouldFail">): LevelDef => d;

export const LEVELS: LevelDef[] = [
  level1,
  planned({
    id: "freeze", n: 2, title: "Freeze and clawback", feature: "Clawback",
    goal: "As the issuer, freeze a flagged holder, then claw back issued funds on a currency that has clawback enabled.",
    shouldFail: "Try a clawback on a currency that never enabled clawback, or send the clawback from a non-issuer.",
    rejectReason: "Clawback is refused unless the issuer enabled it, and only the issuer can submit it.",
    expectedRejects: ["tecNO_PERMISSION", "temMALFORMED"],
    goalRoles: ["issuer"], shouldFailRoles: ["issuer", "holder", "auditor"],
    bots: "A holder bot receives tokens. The auditor bot flags the account.",
    docs: [
      { title: "Freezing tokens", href: "https://xrpl.org/docs/concepts/tokens/fungible-tokens/freezes" },
      { title: "Clawing back tokens", href: "https://xrpl.org/docs/concepts/tokens/fungible-tokens/clawing-back-tokens" },
    ],
  }),
  planned({
    id: "creds", n: 3, title: "Issue and accept a credential", feature: "Credentials",
    goal: "The issuer creates a credential; the holder accepts it so the credential is live.",
    shouldFail: "Accept a credential that was not issued to you.",
    rejectReason: "Only the credential's subject can accept it, and it is not in force until accepted.",
    expectedRejects: ["tecNO_ENTRY", "tecNO_PERMISSION"],
    goalRoles: ["issuer", "holder"], shouldFailRoles: ["holder", "auditor"],
    bots: "The other seat is filled by a bot so create and accept can still complete.",
    docs: [{ title: "Credentials", href: "https://xrpl.org/docs/concepts/decentralized-storage/credentials" }],
  }),
  planned({
    id: "domain", n: 4, title: "Open a permissioned domain", feature: "PermissionedDomains",
    goal: "Create a domain that admits only the accepted credential, then show the holder qualifies.",
    shouldFail: "Act inside the domain from an account that lacks the required credential.",
    rejectReason: "The domain admits only accounts that hold an accepted credential it lists.",
    expectedRejects: ["tecNO_PERMISSION"],
    goalRoles: ["issuer", "holder"], shouldFailRoles: ["holder", "lender", "borrower"],
    bots: "A credentialed holder bot joins cleanly. An uncredentialed bot is refused.",
    docs: [{ title: "Permissioned domains", href: "https://xrpl.org/docs/concepts/tokens/decentralized-exchange/permissioned-domains" }],
  }),
  planned({
    id: "batch", n: 5, title: "Batch: create plus accept", feature: "Batch",
    goal: "Submit one batch whose inner transactions land together or not at all.",
    shouldFail: "Submit an all-or-nothing batch where one inner transaction cannot succeed.",
    rejectReason: "In all-or-nothing mode, if one inner transaction fails, none apply.",
    expectedRejects: ["tecBATCH_FAILURE"],
    goalRoles: ["issuer", "holder"], shouldFailRoles: ["issuer", "holder"],
    bots: "The counterparty bot signs its half of the batch.",
    docs: [{ title: "Batch transactions", href: "https://xrpl.org/docs/concepts/transactions/batch-transactions" }],
  }),
  planned({
    id: "vault", n: 6, title: "Deposit in a single-asset vault", feature: "SingleAssetVault", priority: true,
    goal: "Deposit the test token into a vault, receive shares, and withdraw only your share.",
    shouldFail: "Withdraw more than your shares are worth, or withdraw from an account that holds no shares.",
    rejectReason: "A vault pays out only against shares the account holds.",
    expectedRejects: ["tecINSUFFICIENT_FUNDS", "tecNO_PERMISSION"],
    goalRoles: ["holder", "lender"], shouldFailRoles: ["holder", "lender", "borrower"],
    bots: "Other holder bots deposit so the vault has more than one shareholder. The auditor tracks shares.",
    docs: [
      { title: "Single asset vaults", href: "https://xrpl.org/docs/concepts/tokens/single-asset-vaults" },
      { title: "Known amendments", href: "https://xrpl.org/resources/known-amendments" },
    ],
  }),
  planned({
    id: "lend", n: 7, title: "Fund a loan and repay it", feature: "LendingProtocol", priority: true,
    goal: "The lender sets up a loan broker on a vault; a borrower takes a fixed-term loan and repays it.",
    shouldFail: "Draw a loan the broker's terms don't allow, or pull vault funds that cover open loans.",
    rejectReason: "The protocol rejects actions that break the broker's terms or the vault's cover.",
    expectedRejects: ["tecNO_PERMISSION", "tecINSUFFICIENT_FUNDS"],
    goalRoles: ["lender", "borrower"], shouldFailRoles: ["borrower", "lender", "holder"],
    bots: "The other side of the loan is a bot. The auditor watches the loan object through fund, draw, and repay.",
    docs: [
      { title: "Lending protocol", href: "https://xrpl.org/docs/concepts/tokens/lending-protocol" },
      { title: "Known amendments", href: "https://xrpl.org/resources/known-amendments" },
    ],
  }),
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
      "The ConfidentialTransfer amendment is a proposal in amendment voting; check its status on the Known Amendments page and in this game's live amendment check.",
      "Per xrpl.org, it uses EC-ElGamal encryption and zero-knowledge proofs so individual MPT balances and transfer amounts are shielded from public view (spec: XLS-96).",
      "Compliance still works: authorized parties such as the issuer or a designated auditor can verify total supply.",
      "This level becomes interactive only after the live check shows ConfidentialTransfer enabled on the selected test network.",
    ],
  }),
];

/** Scored levels are the seven from the design page; the explainer is unscored. */
export const SCORED_LEVELS = LEVELS.filter((l) => l.n <= 7);

export function findLevel(id: string): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}
