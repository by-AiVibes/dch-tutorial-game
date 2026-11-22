// Per-level quizzes (questions verbatim from the quiz plan, 2026-11-22). Answers and "why"
// lines stay on the server: publicQuiz() strips them before anything reaches the browser.
// Every "why" comes from the level's own text, which links to xrpl.org.

export interface QuizQuestion {
  q: string;
  choices: string[];
  /** Index of the correct choice (server-only). */
  answer: number;
  /** One line shown after a wrong answer (server-only until then). */
  why: string;
}

/** Points per correct answer on the FIRST attempt only; later attempts unlock advancement but add no points. */
export const QUIZ_POINTS = 10;
/** Correct answers needed to pass a quiz. */
export const QUIZ_PASS = 2;

export const QUIZZES: Record<string, QuizQuestion[]> = {
  wallet: [
    { q: "What is testnet/devnet XRP worth?", choices: ["Same as mainnet XRP", "Nothing, it's free from a faucet", "1 cent each"], answer: 1,
      why: "Test-network XRP is free from a faucet and has no value; the network can be reset at any time." },
    { q: "What does this game send to the server?", choices: ["Your seed", "Only your address (r...)", "Your seed and address"], answer: 1,
      why: "The seed is your secret key: it's made in your browser and never sent. Only your address (r…) is shared." },
    { q: "How does a new account get created?", choices: ["You sign up on a website", "Someone sends it enough XRP to meet the base reserve", "It exists as soon as you make a seed"], answer: 1,
      why: "An account is created by sending it enough XRP to meet the base reserve; the faucet does that for you." },
  ],
  issue: [
    { q: "Which wallet should have DefaultRipple turned on?", choices: ["Every holder", "The issuer", "Nobody"], answer: 1,
      why: "As the issuer, you turn on DefaultRipple; holders open NoRipple trust lines." },
    { q: "Holders' trust lines should have which flag set?", choices: ["NoRipple", "DefaultRipple", "Freeze"], answer: 0,
      why: "Holders open NoRipple trust lines, so value can't ripple through them." },
    { q: "A payment tries to hop through a holder whose lines are NoRipple. What happens?", choices: ["It goes through", "It fails, the path is dry", "The issuer pays instead"], answer: 1,
      why: "A payment cannot ripple through a wallet whose trust lines have NoRipple set; the path is dry." },
  ],
  freeze: [
    { q: "Who can claw back a token?", choices: ["Any holder", "Only the issuer, and only if it enabled clawback", "The auditor"], answer: 1,
      why: "Clawback is refused unless the issuer enabled it, and only the issuer can submit it." },
    { q: "The Level 1 issuer never enabled clawback. Can it claw back TST?", choices: ["Yes", "No, it's refused", "Only from frozen lines"], answer: 1,
      why: "Clawback is refused unless the issuer enabled it first." },
    { q: "Freezing a trust line does what?", choices: ["Deletes the tokens", "Stops the frozen tokens from moving, except straight back to the issuer", "Sends them back to the issuer"], answer: 1,
      why: "A freeze stops the tokens on that line from moving, except straight back to the issuer; it doesn't delete them (clawback takes them back)." },
  ],
  creds: [
    { q: "Who can accept a credential?", choices: ["Anyone", "The issuer", "Only the credential's subject"], answer: 2,
      why: "Only the credential's subject can accept it." },
    { q: "When is a credential in force?", choices: ["As soon as it's issued", "After the subject accepts it", "After 24 hours"], answer: 1,
      why: "A credential is not in force until its subject accepts it." },
    { q: "Who creates the credential?", choices: ["The holder", "The issuer", "A validator"], answer: 1,
      why: "The issuer creates the credential; the holder accepts it." },
  ],
  domain: [
    { q: "Who can trade in a permissioned domain's DEX?", choices: ["Everyone", "Only accounts holding an accepted credential the domain lists", "Only the issuer"], answer: 1,
      why: "The domain admits only accounts that hold an accepted credential it lists." },
    { q: "A bot with no DCH-KYC credential places an offer in the domain. Result?", choices: ["It works", "It's refused", "It's queued until approved"], answer: 1,
      why: "Without an accepted credential the domain lists, the offer is refused." },
    { q: "What does Level 4 build on from Level 3?", choices: ["Clawback", "The DCH-KYC credential", "The vault"], answer: 1,
      why: "The domain accepts the issuer's DCH-KYC credential from Level 3." },
  ],
  batch: [
    { q: "In all-or-nothing mode, one inner transaction fails. What happens?", choices: ["The others still apply", "None of them apply", "Only the first applies"], answer: 1,
      why: "In all-or-nothing mode, if one inner transaction fails, none apply." },
    { q: "Can the outer Batch still show tesSUCCESS when the inner ones didn't apply?", choices: ["No, never", "Yes, it still pays the fee", "Only on mainnet"], answer: 1,
      why: "The outer Batch can still be tesSUCCESS (it pays the fee), so the game checks that the create did not land." },
    { q: "Why does the holder bot sign?", choices: ["It pays the batch fee for everyone", "It co-signs the whole batch, because one inner transaction is its own", "It doesn't sign; only the issuer does"], answer: 1,
      why: "In a multi-account batch, every account whose transaction is inside signs the whole batch (all inner transactions), not just its own part." },
  ],
  vault: [
    { q: "What do you get when you deposit into a vault?", choices: ["A loan", "Shares", "A credential"], answer: 1,
      why: "Depositors get shares in the vault." },
    { q: "The borrower holds no shares and tries to withdraw. Result?", choices: ["It works", "It's refused", "It gets the lender's shares"], answer: 1,
      why: "A vault pays out only against shares the account holds." },
    { q: "A holder can withdraw:", choices: ["Anyone's deposit", "Only against its own shares", "Nothing until the vault closes"], answer: 1,
      why: "The holder withdraws only its own share: a vault pays out only against shares the account holds." },
  ],
  lend: [
    { q: "Who signs the loan?", choices: ["Only the borrower", "The lender (broker) and borrower together", "The auditor"], answer: 1,
      why: "The lender co-signs the loan with the borrower." },
    { q: "The broker's debt maximum is 20 XRP. A 25 XRP loan is tried. Result?", choices: ["It's approved", "It's rejected", "It's cut to 20 XRP"], answer: 1,
      why: "A loan that would push the broker past its DebtMaximum is rejected." },
    { q: "Where does the money lent come from?", choices: ["The faucet", "The lender's vault", "The borrower's trust line"], answer: 1,
      why: "The lender funds its vault, and the loan broker lends from it." },
  ],
  confidential: [
    { q: "What's an MPT held with?", choices: ["A trust line", "Directly in the account, no trust line", "An NFT"], answer: 1,
      why: "Multi-purpose tokens (MPTs) are held directly in an account, without a trust line." },
    { q: "What does ConfidentialTransfer hide from public view?", choices: ["Account addresses", "Individual MPT balances and transfer amounts", "Everything about the token"], answer: 1,
      why: "Per xrpl.org, individual MPT balances and transfer amounts are shielded from public view." },
    { q: "Can the issuer or a designated auditor still verify total supply?", choices: ["Yes", "No", "Only on devnet"], answer: 0,
      why: "Compliance still works: the issuer or a designated auditor can verify total supply." },
  ],
};

export const QUIZ_LEVELS = Object.keys(QUIZZES);
export const QUIZ_MAX = QUIZ_LEVELS.reduce((n, id) => n + QUIZZES[id].length * QUIZ_POINTS, 0); // 9 x 3 x 10 = 270

/** What the browser may see: questions and choices only. */
export function publicQuiz(levelId: string) {
  const qs = QUIZZES[levelId];
  return qs ? qs.map((x) => ({ q: x.q, choices: [...x.choices] })) : null;
}

/** Per-world quiz progress for one level (stored in the world file). */
export interface QuizProgress {
  /** Answers in the current attempt, in order. */
  answers: { choice: number; correct: boolean }[];
  passed: boolean;
  /** First-attempt points (correct answers on attempt 1 x QUIZ_POINTS), set when attempt 1 ends. */
  points: number;
  attempts: number;
}

export const emptyProgress = (): QuizProgress => ({ answers: [], passed: false, points: 0, attempts: 1 });

export function quizPoints(quizzes: Record<string, QuizProgress> | undefined): number {
  return Object.values(quizzes ?? {}).reduce((n, p) => n + (p.points || 0), 0);
}
