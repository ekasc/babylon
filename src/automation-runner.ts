// Automation executor for Phase 8, Feature 16.
//
// Reuses the permission system and completion contracts: every automation run
// creates inspectable history, failures enter the Attention Inbox, and no
// hidden background agents are created. The scheduler and background policy
// decide *which* tasks are runnable; this module decides what a run *does*.

import { addAttention, type AttentionRegistry } from "./attention";
import { recordRun, type ScheduledTask, type ScheduledTaskRegistry } from "./automation";
import { evaluateContract, type CheckResult, type CompletionContract } from "./completion-contracts";
import { makeId } from "./runtime";

export type AutomationRunStatus = "succeeded" | "failed";

export interface AutomationRun {
  id: string;
  taskId: string;
  taskName: string;
  startedAt: number;
  finishedAt: number;
  status: AutomationRunStatus;
  error?: string;
  contractPassed?: boolean;
}

export interface AutomationHistory {
  runs: AutomationRun[];
}

export function createAutomationHistory(): AutomationHistory {
  return { runs: [] };
}

export interface RunnerResult {
  success: boolean;
  error?: string;
  /** Optional check results for completion-contract evaluation. */
  checkResults?: CheckResult[];
}

export interface ExecutionInput {
  registry: ScheduledTaskRegistry;
  runnable: ScheduledTask[];
  history: AutomationHistory;
  attention: AttentionRegistry;
  contracts?: Record<string, CompletionContract>;
  now: number;
  run: (task: ScheduledTask) => RunnerResult;
}

export interface ExecutionOutput {
  registry: ScheduledTaskRegistry;
  history: AutomationHistory;
  attention: AttentionRegistry;
}

function cloneHistory(h: AutomationHistory): AutomationHistory {
  return { runs: [...h.runs] };
}

export function executeDueTasks(input: ExecutionInput): ExecutionOutput {
  let registry = input.registry;
  let history = cloneHistory(input.history);
  let attention = input.attention;

  for (const task of input.runnable) {
    const startedAt = input.now;
    let result: RunnerResult;
    try {
      result = input.run(task);
    } catch (e) {
      result = { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    let status: AutomationRunStatus = result.success ? "succeeded" : "failed";
    let error = result.error;
    let contractPassed: boolean | undefined;

    const contract = input.contracts?.[task.id];
    if (contract && result.checkResults?.length) {
      const evaluation = evaluateContract(contract, result.checkResults);
      contractPassed = evaluation.passed;
      if (!evaluation.passed) {
        status = "failed";
        const failed = evaluation.checks
          .filter((c) => c.check.required && !c.satisfied)
          .map((c) => c.check.label);
        error = failed.length ? `contract failed: ${failed.join(", ")}` : "contract failed";
      }
    } else if (contract && !result.checkResults?.length && result.success) {
      // No check results supplied for a contracted task — treat as not satisfied
      // so the trustworthy state remains contract passed, not agent finished.
      contractPassed = false;
      status = "failed";
      error = "contract failed: missing check results";
    }

    registry = recordRun(registry, task.id, startedAt);
    const run: AutomationRun = {
      id: makeId("autorun"),
      taskId: task.id,
      taskName: task.name,
      startedAt,
      finishedAt: startedAt,
      status,
      error: status === "failed" ? error ?? "failed" : undefined,
      contractPassed,
    };
    history = { runs: [...history.runs, run] };

    if (status === "failed") {
      attention = addAttention(attention, {
        id: `automation-${run.id}`,
        type: "failed_task",
        title: `Automation failed: ${task.name}`,
        detail: error ?? "task failed",
        createdAt: startedAt,
        resolved: false,
        source: task.id,
      });
      // addAttention is no-overwrite; if the same run id somehow repeats, keep first.
    }
  }

  return { registry, history, attention };
}
