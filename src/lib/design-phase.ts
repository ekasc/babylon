/**
 * Design sub-phase display (item 3).
 *
 * Everything here is DERIVED. The only persisted input is the phase the model
 * reported; the round numbers come from the review records that already exist
 * on disk (and in the transcript, since every review is a tool call). There is
 * deliberately no persisted "last round" — a counter that duplicates a
 * derivable fact is a second authority waiting to disagree.
 */

export type DesignPhase = "implementing" | "revising" | "needs-user";

export interface DesignReviewSummary {
  round: number;
  verdict: "pass" | "fail";
}

export interface DesignSubphaseInput {
  /** The phase persisted on the design state, if any. */
  phase?: DesignPhase;
  /** Completed reviews, from the transcript (each one is a `design_review`
   *  tool call, so they survive reload and carry their own round). */
  reviews: readonly DesignReviewSummary[];
  /** A `design_review` tool call is in flight right now. */
  reviewInFlight: boolean;
  /** The round budget, owned by the backend. */
  maxRounds: number;
}

export type DesignSubphaseKind = "building" | "reviewing" | "revising" | "needs-user";

export interface DesignSubphase {
  kind: DesignSubphaseKind;
  /** Composer label suffix, e.g. "Reviewing 2/3". */
  label: string;
  /** Completed rounds, when the label is about a round. */
  round?: number;
  /** Total budget, when the label is about a round. */
  maxRounds?: number;
}

const isPhase = (value: unknown): value is DesignPhase =>
  value === "implementing" || value === "revising" || value === "needs-user";

/** The newest completed review. Rounds are unique, so a later record always
 *  wins; duplicates (a replayed event) resolve to the same round harmlessly. */
export function latestReview(reviews: readonly DesignReviewSummary[]): DesignReviewSummary | null {
  let latest: DesignReviewSummary | null = null;
  for (const review of reviews) {
    if (!Number.isFinite(review.round) || review.round < 1) continue;
    if (review.verdict !== "pass" && review.verdict !== "fail") continue;
    if (!latest || review.round > latest.round) latest = review;
  }
  return latest;
}

/** The next round is one past the last COMPLETED one. A capture that crashed
 *  mid-flight leaves no record, so the number never claims a round that did
 *  not happen. */
export function nextReviewRound(reviews: readonly DesignReviewSummary[]): number {
  const latest = latestReview(reviews);
  return latest ? latest.round + 1 : 1;
}

export function deriveDesignSubphase(input: DesignSubphaseInput): DesignSubphase {
  const { reviewInFlight, maxRounds } = input;
  const latest = latestReview(input.reviews);

  // An in-flight review is visible as a running tool call: no persisted
  // "reviewing" phase is needed, and a crash cannot leave one behind.
  if (reviewInFlight) {
    return {
      kind: "reviewing",
      label: `Reviewing ${nextReviewRound(input.reviews)}/${maxRounds}`,
      round: nextReviewRound(input.reviews),
      maxRounds,
    };
  }

  // The budget is spent, or the model said it cannot continue unattended.
  if (input.phase === "needs-user") {
    return { kind: "needs-user", label: "Needs you" };
  }
  if (latest && latest.round >= maxRounds && latest.verdict === "fail") {
    return { kind: "needs-user", label: "Needs you" };
  }

  if (input.phase === "revising" && latest?.verdict === "fail") {
    return {
      kind: "revising",
      label: `Revising ${latest.round}/${maxRounds}`,
      round: latest.round,
      maxRounds,
    };
  }

  return { kind: "building", label: "Building" };
}

/** Narrow an untrusted phase (design state crosses a process boundary). An
 *  unknown value is treated as "no phase", never as a guess. */
export function parseDesignPhase(value: unknown): DesignPhase | undefined {
  return isPhase(value) ? value : undefined;
}
