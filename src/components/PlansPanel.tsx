import { useState } from "react";
import {
  addStep,
  approveStep,
  canRunStep,
  createPlan,
  reconcile,
  removeStep,
  setStepStatus,
  startPlan,
  type Plan,
  type PlanStepStatus,
} from "../plans";

const STATUS_LABEL: Record<PlanStepStatus, string> = {
  proposed: "Proposed",
  approved: "Approved",
  running: "Running",
  paused: "Paused",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * Structured Plans surface. Plans are first-class Babylon state: the agent can
 * propose an ordered, dependency-aware list of steps and stop before execution
 * when approval is required. This panel is the user-facing editor; the pure
 * transitions live in ../plans so the model stays testable.
 */
export function PlansPanel({
  plans,
  setPlans,
  onClose,
}: {
  plans: Record<string, Plan>;
  setPlans: (next: Record<string, Plan>) => void;
  onClose: () => void;
}) {
  const [newTitle, setNewTitle] = useState("");
  const [newSteps, setNewSteps] = useState("");

  const upsert = (plan: Plan) => setPlans({ ...plans, [plan.id]: reconcile(plan) });

  const create = () => {
    const title = newTitle.trim();
    if (!title) return;
    const steps = newSteps
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ title: s }));
    const plan = createPlan({
      id: `plan-${Date.now()}`,
      title,
      steps,
      createdAt: Date.now(),
    });
    upsert(plan);
    setNewTitle("");
    setNewSteps("");
  };

  return (
    <div className="plans-panel">
      <div className="panel-head">
        <span className="panel-title">Plans</span>
        <button className="thread-action" onClick={onClose} title="Close">
          Close
        </button>
      </div>

      <div className="plans-composer">
        <input
          className="text-input"
          placeholder="Plan title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <textarea
          className="text-input"
          placeholder="One step per line"
          rows={4}
          value={newSteps}
          onChange={(e) => setNewSteps(e.target.value)}
        />
        <button className="thread-action" onClick={create}>
          New plan
        </button>
      </div>

      {Object.values(plans).length === 0 ? (
        <p className="text-dim">No plans yet. Propose one above or let the agent suggest steps.</p>
      ) : (
        Object.values(plans).map((plan) => (
          <div key={plan.id} className="plan-card">
            <div className="plan-head">
              <span className="plan-title">{plan.title}</span>
              <span className="plan-status">{STATUS_LABEL[plan.status]}</span>
            </div>
            <ol className="plan-steps">
              {plan.steps.map((step, i) => (
                <li key={step.id} className="plan-step">
                  <span className="step-index">{i + 1}</span>
                  <span className="step-title">{step.title}</span>
                  <span className="step-status">{STATUS_LABEL[step.status]}</span>
                  <span className="step-actions">
                    {step.status === "proposed" ? (
                      <button className="thread-action" onClick={() => upsert(approveStep(plan, step.id))}>
                        Approve
                      </button>
                    ) : null}
                    {step.status === "approved" && canRunStep(plan, step.id) ? (
                      <button
                        className="thread-action"
                        onClick={() => upsert(setStepStatus(startPlan(plan), step.id, "running"))}
                      >
                        Start
                      </button>
                    ) : null}
                    {step.status === "running" ? (
                      <button
                        className="thread-action"
                        onClick={() => upsert(setStepStatus(plan, step.id, "completed"))}
                      >
                        Complete
                      </button>
                    ) : null}
                    <button className="thread-action" onClick={() => upsert(removeStep(plan, step.id))}>
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))
      )}
    </div>
  );
}
