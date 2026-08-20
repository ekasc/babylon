// Scheduler decision engine for Phase 8 (Automation) wired to Phase 6 (Control
// Plane, Feature 14: background execution policies).
//
// The ROADMAP lets Babylon run tasks on a schedule once background execution is
// reliable, and requires explicit policies to gate background work. This module
// is the decision layer that sits between the automation trigger model and the
// background policy: a task is runnable only when its trigger is due AND the
// background policy permits it for the task's project. It is pure and testable;
// the scheduler loop and agent executor build on top.

import { canRunInBackground, type BackgroundPolicy, type EnvironmentSignals } from "./background-policy";
import { listDueTasks, type ScheduledTask, type ScheduledTaskRegistry, type WatchEvent } from "./automation";

export interface RunnableSelection {
  /** Tasks that are due and permitted by the background policy. */
  runnable: ScheduledTask[];
  /** Due tasks the policy blocked, with the reasons, so the UI can explain them. */
  blocked: { task: ScheduledTask; reasons: string[] }[];
}

export function selectRunnableTasks(
  tasks: ScheduledTaskRegistry,
  policy: BackgroundPolicy,
  defaultProject: string,
  env: EnvironmentSignals,
  now: number,
  event?: WatchEvent
): RunnableSelection {
  const due = listDueTasks(tasks, now, event);
  const runnable: ScheduledTask[] = [];
  const blocked: { task: ScheduledTask; reasons: string[] }[] = [];
  for (const task of due) {
    // Treat a blank project as unset so a cleared input does not silently run
    // the task outside the intended per-project gating.
    const project = task.project && task.project.trim() ? task.project : defaultProject;
    const decision = canRunInBackground(policy, project, env);
    if (decision.allowed) runnable.push(task);
    else blocked.push({ task, reasons: decision.reasons });
  }
  return { runnable, blocked };
}
