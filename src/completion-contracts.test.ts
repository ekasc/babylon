import { describe, expect, it } from "vitest";
import {
  addCheck,
  createContract,
  evaluateContract,
  removeCheck,
  type CheckResult,
  type CompletionContract,
} from "./completion-contracts";

function base(): CompletionContract {
  return createContract({
    id: "c1",
    title: "Definition of Done",
    checks: [
      { kind: "typecheck", label: "Typecheck", required: true },
      { kind: "tests", label: "Unit tests", required: true },
      { kind: "lint", label: "Lint", required: false },
    ],
  });
}

describe("completion contracts", () => {
  it("adds and removes checks without duplicates", () => {
    let c = base();
    c = addCheck(c, { kind: "typecheck", label: "Typecheck", required: true }); // dup ignored
    c = addCheck(c, { kind: "review", label: "Review", required: true });
    expect(c.checks).toHaveLength(4);
    c = removeCheck(c, "review");
    expect(c.checks.map((k) => k.kind)).toEqual(["typecheck", "tests", "lint"]);
  });

  it("passes when all required checks pass (optional may fail)", () => {
    const results: CheckResult[] = [
      { kind: "typecheck", passed: true },
      { kind: "tests", passed: true },
      { kind: "lint", passed: false }, // optional, ignored
    ];
    expect(evaluateContract(base(), results).passed).toBe(true);
  });

  it("fails when a required check fails", () => {
    const results: CheckResult[] = [
      { kind: "typecheck", passed: false },
      { kind: "tests", passed: true },
    ];
    const e = evaluateContract(base(), results);
    expect(e.passed).toBe(false);
    expect(e.checks.find((c) => c.check.kind === "typecheck")?.satisfied).toBe(false);
  });

  it("fails when a required result is missing", () => {
    const results: CheckResult[] = [{ kind: "tests", passed: true }];
    expect(evaluateContract(base(), results).passed).toBe(false);
  });

  it("passes an empty contract", () => {
    expect(evaluateContract(createContract({ id: "x", title: "t" }), []).passed).toBe(true);
  });
});
