// Background Execution Policies for Phase 6 (Control Plane).
//
// Once the runtime is extracted, background work needs explicit gating: when it
// may run (never / while plugged in / always), plus controls for battery, sleep,
// concurrency, spend, and per-project permission. This is a pure evaluator: it
// takes a policy, a project, and observed environment signals and reports
// whether background execution is allowed and why not.

export type BackgroundMode = "never" | "while_plugged_in" | "always";

export interface BackgroundPolicy {
  mode: BackgroundMode;
  pauseOnBattery: boolean;
  pauseOnSleep: boolean;
  resumeAfterWake: boolean;
  maxConcurrentAgents: number;
  maxBackgroundCost: number;
  perProjectPermission: Record<string, boolean>;
}

export interface EnvironmentSignals {
  onBattery: boolean;
  asleep: boolean;
  activeAgents: number;
  currentCost: number;
}

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
}

export function defaultPolicy(): BackgroundPolicy {
  return {
    mode: "while_plugged_in",
    pauseOnBattery: true,
    pauseOnSleep: true,
    resumeAfterWake: true,
    maxConcurrentAgents: 4,
    maxBackgroundCost: 10,
    perProjectPermission: {},
  };
}

/**
 * Decide whether background execution is allowed for `project` under `env`.
 * Reasons are accumulated so the UI can explain a denial. Hard gates (mode,
 * battery, sleep, concurrency, cost, per-project) all block; `resumeAfterWake`
 * only affects scheduling on wake and is not a gate here.
 */
export function canRunInBackground(
  policy: BackgroundPolicy,
  project: string,
  env: EnvironmentSignals
): PolicyDecision {
  const reasons: string[] = [];

  if (policy.mode === "never") {
    reasons.push("Background mode is set to never");
  }
  if (policy.mode === "while_plugged_in" && env.onBattery) {
    reasons.push("Mode is while-plugged-in and the device is on battery");
  }
  if (policy.mode === "always" && policy.pauseOnBattery && env.onBattery) {
    reasons.push("Mode is always but pause-on-battery is enabled and the device is on battery");
  }
  if (policy.pauseOnSleep && env.asleep) {
    reasons.push("Pause-on-sleep is enabled and the device is asleep");
  }
  if (env.activeAgents >= policy.maxConcurrentAgents) {
    reasons.push(
      `Active agents (${env.activeAgents}) reached the limit (${policy.maxConcurrentAgents})`
    );
  }
  if (env.currentCost >= policy.maxBackgroundCost) {
    reasons.push(
      `Background cost (${env.currentCost}) reached the limit (${policy.maxBackgroundCost})`
    );
  }
  if (policy.perProjectPermission[project] === false) {
    reasons.push(`Background work is denied for project ${project}`);
  }

  return { allowed: reasons.length === 0, reasons };
}
