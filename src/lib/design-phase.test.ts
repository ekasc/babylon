import { describe, expect, it } from "vitest";
import {
  deriveDesignSubphase,
  latestReview,
  nextReviewRound,
  parseDesignPhase,
} from "./design-phase";

const reviews = (...rounds: Array<{ round: number; verdict: "pass" | "fail" }>) => rounds;
const base = { phase: undefined, reviews: [], reviewInFlight: false, maxRounds: 3 };

describe("design subphase derivation", () => {
  it("shows Building while a build is simply under way", () => {
    expect(deriveDesignSubphase(base)).toEqual({ kind: "building", label: "Building" });
    expect(deriveDesignSubphase({ ...base, phase: "implementing" })).toEqual({
      kind: "building",
      label: "Building",
    });
  });

  it("shows Reviewing for the round about to be attempted, never a repeated one", () => {
    expect(deriveDesignSubphase({ ...base, reviewInFlight: true })).toEqual({
      kind: "reviewing",
      label: "Reviewing 1/3",
      round: 1,
      maxRounds: 3,
    });
    // One round is done: the next attempt is round 2, not round 1 again.
    expect(
      deriveDesignSubphase({ ...base, reviewInFlight: true, reviews: reviews({ round: 1, verdict: "fail" }) })
    ).toEqual({ kind: "reviewing", label: "Reviewing 2/3", round: 2, maxRounds: 3 });
  });

  it("shows Revising only when a failing review is actually being revised", () => {
    const failing = reviews({ round: 1, verdict: "fail" });
    expect(deriveDesignSubphase({ ...base, phase: "revising", reviews: failing })).toEqual({
      kind: "revising",
      label: "Revising 1/3",
      round: 1,
      maxRounds: 3,
    });
    // A passing latest review means there is nothing to revise.
    expect(
      deriveDesignSubphase({
        ...base,
        phase: "revising",
        reviews: reviews({ round: 1, verdict: "fail" }, { round: 2, verdict: "pass" }),
      }).kind
    ).toBe("building");
  });

  it("shows Needs you when the model asks, or when the budget is spent on a failure", () => {
    expect(deriveDesignSubphase({ ...base, phase: "needs-user" }).label).toBe("Needs you");
    const spent = reviews(
      { round: 1, verdict: "fail" },
      { round: 2, verdict: "fail" },
      { round: 3, verdict: "fail" }
    );
    // No phase was ever reported, yet the third failure means the loop is done.
    expect(deriveDesignSubphase({ ...base, reviews: spent }).label).toBe("Needs you");
    // A PASS on the final round is a pass, not an escalation.
    const passed = reviews({ round: 1, verdict: "fail" }, { round: 2, verdict: "fail" }, { round: 3, verdict: "pass" });
    expect(deriveDesignSubphase({ ...base, reviews: passed }).kind).toBe("building");
  });

  it("prefers the in-flight review over any persisted phase", () => {
    expect(
      deriveDesignSubphase({
        ...base,
        phase: "needs-user",
        reviewInFlight: true,
        reviews: reviews({ round: 1, verdict: "fail" }),
      }).label
    ).toBe("Reviewing 2/3");
  });

  it("treats a crash mid-capture as a round that never happened", () => {
    // No record exists, so the next attempt is still round 1 — the label never
    // claims progress that was lost.
    expect(nextReviewRound([])).toBe(1);
    expect(deriveDesignSubphase({ ...base, reviewInFlight: true }).label).toBe("Reviewing 1/3");
  });

  it("ignores malformed reviews rather than trusting them", () => {
    const junk = reviews(
      { round: 0, verdict: "fail" },
      { round: Number.NaN, verdict: "pass" }
    );
    expect(latestReview(junk)).toBeNull();
    expect(nextReviewRound(junk)).toBe(1);
    expect(deriveDesignSubphase({ ...base, phase: "revising", reviews: junk }).kind).toBe("building");
  });

  it("takes the highest round regardless of transcript order", () => {
    const unordered = reviews({ round: 2, verdict: "fail" }, { round: 1, verdict: "pass" });
    expect(latestReview(unordered)?.round).toBe(2);
    expect(deriveDesignSubphase({ ...base, phase: "revising", reviews: unordered }).label).toBe("Revising 2/3");
  });

  it("never lets an untrusted phase string through", () => {
    expect(parseDesignPhase("revising")).toBe("revising");
    expect(parseDesignPhase("reviewing")).toBeUndefined();
    expect(parseDesignPhase(7)).toBeUndefined();
    expect(parseDesignPhase(undefined)).toBeUndefined();
  });
});
