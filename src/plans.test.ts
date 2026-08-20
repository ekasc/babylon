import { describe, expect, it } from "vitest";
import {
  addStep,
  approveStep,
  canRunStep,
  cancelPlan,
  completePlan,
  createPlan,
  pausePlan,
  reconcile,
  rejectStep,
  removeStep,
  reorderSteps,
  setStepStatus,
  startPlan,
  type Plan,
} from "./plans";

function samplePlan(): Plan {
  return createPlan({
    id: "p1",
    title: "Refactor auth",
    createdAt: 100,
    steps: [
      { title: "Audit usages" },
      { title: "Extract module", dependsOn: ["p1-s1"] },
      { title: "Update callers", dependsOn: ["p1-s2"] },
    ],
  });
}

describe("createPlan", () => {
  it("creates proposed steps with deterministic ids", () => {
    const p = samplePlan();
    expect(p.status).toBe("proposed");
    expect(p.steps.map((s) => s.id)).toEqual(["p1-s1", "p1-s2", "p1-s3"]);
    expect(p.steps.every((s) => s.status === "proposed" && s.approval === "unset")).toBe(true);
  });
});

describe("step mutations", () => {
  it("adds a step with the next id", () => {
    const p = addStep(samplePlan(), { title: "Ship" });
    expect(p.steps).toHaveLength(4);
    expect(p.steps[3].id).toBe("p1-s4");
  });

  it("removes a step and clears dangling dependencies", () => {
    const p = removeStep(samplePlan(), "p1-s2");
    expect(p.steps.map((s) => s.id)).toEqual(["p1-s1", "p1-s3"]);
    expect(p.steps[1].dependsOn).toEqual([]);
  });

  it("reorders steps only with a complete, valid ordering", () => {
    const p = samplePlan();
    const reordered = reorderSteps(p, ["p1-s3", "p1-s1", "p1-s2"]);
    expect(reordered.steps.map((s) => s.id)).toEqual(["p1-s3", "p1-s1", "p1-s2"]);
    // Invalid ordering (missing a step) is ignored.
    expect(reorderSteps(p, ["p1-s1"]).steps).toEqual(p.steps);
  });

  it("approves and rejects steps", () => {
    const approved = approveStep(samplePlan(), "p1-s1");
    expect(approved.steps[0]).toMatchObject({ approval: "approved", status: "approved" });
    const rejected = rejectStep(samplePlan(), "p1-s2");
    expect(rejected.steps[1]).toMatchObject({ approval: "rejected", status: "cancelled" });
  });

  it("completing a step sets progress to 1", () => {
    const p = setStepStatus(samplePlan(), "p1-s1", "completed");
    expect(p.steps[0].progress).toBe(1);
  });
});

describe("canRunStep", () => {
  it("allows steps without dependencies", () => {
    expect(canRunStep(samplePlan(), "p1-s1")).toBe(true);
  });

  it("blocks dependent steps until dependencies complete", () => {
    const p = samplePlan();
    expect(canRunStep(p, "p1-s2")).toBe(false);
    const done = setStepStatus(p, "p1-s1", "completed");
    expect(canRunStep(done, "p1-s2")).toBe(true);
  });
});

describe("reconcile / status derivation", () => {
  it("stays proposed until steps change", () => {
    expect(reconcile(samplePlan()).status).toBe("proposed");
  });

  it("becomes running when a step is running", () => {
    const p = startPlan(setStepStatus(samplePlan(), "p1-s1", "running"));
    expect(p.status).toBe("running");
  });

  it("becomes approved when all steps are approved or completed", () => {
    let p = samplePlan();
    p = approveStep(p, "p1-s1");
    p = approveStep(p, "p1-s2");
    p = approveStep(p, "p1-s3");
    expect(reconcile(p).status).toBe("approved");
  });

  it("becomes completed when every step is completed", () => {
    let p = samplePlan();
    p = setStepStatus(p, "p1-s1", "completed");
    p = setStepStatus(p, "p1-s2", "completed");
    p = setStepStatus(p, "p1-s3", "completed");
    expect(reconcile(p).status).toBe("completed");
  });

  it("becomes blocked when a step is blocked", () => {
    const p = setStepStatus(samplePlan(), "p1-s2", "blocked");
    expect(reconcile(p).status).toBe("blocked");
  });

  it("becomes paused when a step is paused", () => {
    const p = setStepStatus(samplePlan(), "p1-s2", "paused");
    expect(reconcile(p).status).toBe("paused");
  });
});

describe("plan lifecycle", () => {
  it("start, pause, complete, cancel", () => {
    let p = startPlan(samplePlan());
    expect(p.status).toBe("running");
    p = pausePlan(p);
    expect(p.status).toBe("paused");
    p = completePlan(p);
    expect(p.status).toBe("completed");
    p = cancelPlan(p);
    expect(p.status).toBe("cancelled");
  });

  it("cancel clears in-flight steps but keeps settled ones", () => {
    let p = startPlan(samplePlan());
    p = setStepStatus(p, "p1-s1", "completed");
    p = setStepStatus(p, "p1-s2", "running");
    p = cancelPlan(p);
    expect(p.steps[0].status).toBe("completed");
    expect(p.steps[1].status).toBe("cancelled");
  });
});
