// Scoring, as specified on the design page:
// 10 for a level goal, 5 when a should-fail attempt is correctly rejected,
// +5 bonus when both parts of the same level are done. Awarded once per world.

export type Part = "goal" | "shouldFail";

export interface LevelScore {
  goal: boolean;
  shouldFail: boolean;
}

export type Scoreboard = Record<string, LevelScore>;

export const POINTS = { goal: 10, shouldFail: 5, bonus: 5 } as const;
export const LEVEL_COUNT = 7;
export const MAX_SCORE = LEVEL_COUNT * (POINTS.goal + POINTS.shouldFail + POINTS.bonus); // 140

export function levelPoints(s: LevelScore | undefined): number {
  if (!s) return 0;
  return (s.goal ? POINTS.goal : 0) + (s.shouldFail ? POINTS.shouldFail : 0) + (s.goal && s.shouldFail ? POINTS.bonus : 0);
}

export function total(board: Scoreboard): number {
  return Object.values(board).reduce((sum, s) => sum + levelPoints(s), 0);
}

/** Returns the new board and the points this award added (0 if already earned this world). */
export function award(board: Scoreboard, levelId: string, part: Part): { board: Scoreboard; added: number } {
  const before = levelPoints(board[levelId]);
  const cur = board[levelId] ?? { goal: false, shouldFail: false };
  if (cur[part]) return { board, added: 0 };
  const next = { ...board, [levelId]: { ...cur, [part]: true } };
  return { board: next, added: levelPoints(next[levelId]) - before };
}

export type Verdict = "rejected" | "accepted" | "inconclusive";

/**
 * Did a should-fail attempt earn points? Only a FINAL ledger rejection counts.
 * - tec*: rejected only when validated (it's in a validated ledger, fee charged, no effect).
 * - tem* / tef* / tel*: rejected (refused at submission, never applied).
 * - tes*: accepted when validated (a bug in the lesson: flag it, 0 points).
 * - ter*, unvalidated tes/tec, submitError, unknown (timeouts, expired, queued):
 *   inconclusive: 0 points, no flag, try again.
 */
export function judgeShouldFail(engineResult: string, validated: boolean, expected: readonly string[]): {
  verdict: Verdict;
  matchedExpected: boolean;
} {
  let verdict: Verdict = "inconclusive";
  if (/^te[fml][A-Z_]/.test(engineResult)) verdict = "rejected";
  else if (engineResult.startsWith("tec") && validated) verdict = "rejected";
  else if (engineResult.startsWith("tes") && validated) verdict = "accepted";
  return { verdict, matchedExpected: verdict === "rejected" && expected.includes(engineResult) };
}
