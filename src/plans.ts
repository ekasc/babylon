// Structured Plans: first-class Babylon state for proposed agent work.
//
// A plan is an ordered list of steps with explicit status, dependencies,
// affected files, and approval state. The agent can propose a plan and stop
// before implementation when approval is required. All transitions are pure
// functions so the reducer and UI stay simple and testable.

export type PlanStepStatus =
  | "proposed"
  | "approved"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";

export type PlanStatus =
  | "proposed"
  | "approved"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";

export type StepApproval = "unset" | "approved" | "rejected";

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  status: PlanStepStatus;
  /** Ids of steps that must complete before this one may run. */
  dependsOn?: string[];
  affectedFiles?: string[];
  approval: StepApproval;
  /** Execution progress for a running step, 0..1. */
  progress?: number;
}

export interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: number;
  createdBy?: string;
}

export interface PlanDraftStep {
  title: string;
  description?: string;
  dependsOn?: string[];
  affectedFiles?: string[];
}

function step(id: string, draft: PlanDraftStep): PlanStep {
  return {
    id,
    title: draft.title,
    description: draft.description,
    status: "proposed",
    dependsOn: draft.dependsOn,
    affectedFiles: draft.affectedFiles,
    approval: "unset",
  };
}

export function createPlan(params: {
  id: string;
  title: string;
  steps?: PlanDraftStep[];
  createdAt?: number;
  createdBy?: string;
}): Plan {
  return {
    id: params.id,
    title: params.title,
    steps: (params.steps ?? []).map((s, i) => step(`${params.id}-s${i + 1}`, s)),
    status: "proposed",
    createdAt: params.createdAt ?? 0,
    createdBy: params.createdBy,
  };
}

export function addStep(plan: Plan, draft: PlanDraftStep): Plan {
  const id = `${plan.id}-s${plan.steps.length + 1}`;
  return { ...plan, steps: [...plan.steps, step(id, draft)] };
}

export function removeStep(plan: Plan, stepId: string): Plan {
  return {
    ...plan,
    steps: plan.steps.filter((s) => s.id !== stepId).map((s) => ({
      ...s,
      dependsOn: s.dependsOn?.filter((d) => d !== stepId),
    })),
  };
}

export function reorderSteps(plan: Plan, orderedIds: string[]): Plan {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const next = orderedIds
    .map((id) => byId.get(id))
    .filter((s): s is PlanStep => Boolean(s));
  if (next.length !== plan.steps.length) return plan; // ignore invalid orderings
  return { ...plan, steps: next };
}

function withStep(plan: Plan, stepId: string, patch: Partial<PlanStep>): Plan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
  };
}

export function setStepStatus(plan: Plan, stepId: string, status: PlanStepStatus): Plan {
  return withStep(plan, stepId, { status, progress: status === "completed" ? 1 : undefined });
}

export function approveStep(plan: Plan, stepId: string): Plan {
  return withStep(plan, stepId, { approval: "approved", status: "approved" });
}

export function rejectStep(plan: Plan, stepId: string): Plan {
  return withStep(plan, stepId, { approval: "rejected", status: "cancelled" });
}

/** A step may run only when all of its dependencies are completed. */
export function canRunStep(plan: Plan, stepId: string): boolean {
  const target = plan.steps.find((s) => s.id === stepId);
  if (!target?.dependsOn?.length) return true;
  const done = new Set(plan.steps.filter((s) => s.status === "completed").map((s) => s.id));
  return target.dependsOn.every((d) => done.has(d));
}

function deriveStatus(plan: Plan): PlanStatus {
  if (plan.steps.length === 0) return plan.status === "cancelled" ? "cancelled" : "proposed";
  if (plan.steps.some((s) => s.status === "running")) return "running";
  if (plan.steps.some((s) => s.status === "blocked")) return "blocked";
  if (plan.steps.every((s) => s.status === "completed")) return "completed";
  if (plan.steps.every((s) => s.status === "approved" || s.status === "completed")) return "approved";
  if (plan.steps.some((s) => s.status === "paused")) return "paused";
  return "proposed";
}

export function startPlan(plan: Plan): Plan {
  return { ...plan, status: "running" };
}

export function pausePlan(plan: Plan): Plan {
  return { ...plan, status: "paused" };
}

export function completePlan(plan: Plan): Plan {
  return { ...plan, status: "completed" };
}

export function cancelPlan(plan: Plan): Plan {
  return { ...plan, status: "cancelled", steps: plan.steps.map((s) => (s.status === "running" || s.status === "paused" ? { ...s, status: "cancelled" } : s)) };
}

/** Recompute the plan-level status after any step mutation. */
export function reconcile(plan: Plan): Plan {
  return { ...plan, status: deriveStatus(plan) };
}
