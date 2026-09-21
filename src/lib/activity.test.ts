import { describe, expect, it } from "vitest";
import {
  countRunningWork,
  inScope,
  isActiveWorkflow,
  isRunningSubagent,
  isRunningThread,
  subagentCwd,
  threadCwd,
  workflowCwd,
} from "./activity";
import type { SubagentActivity, ThreadActivity, WorkflowRunSummary } from "../bridge";

function thread(overrides: Partial<ThreadActivity> & Pick<ThreadActivity, "threadId" | "status">): ThreadActivity {
  return {
    name: null,
    goal: "",
    mode: "",
    profile: "",
    model: "",
    parentSessionId: "",
    sessionFile: null,
    createdAt: "",
    updatedAt: "",
    completedAt: null,
    latestSummary: null,
    latestActivity: null,
    filesChanged: [],
    commandsRun: [],
    testsRun: [],
    blocker: null,
    failureReason: null,
    ...overrides,
  };
}

function subagent(overrides: Partial<SubagentActivity> & Pick<SubagentActivity, "runId" | "status">): SubagentActivity {
  return {
    updatedAt: "",
    ...overrides,
  };
}

function workflowRun(overrides: Partial<WorkflowRunSummary> & Pick<WorkflowRunSummary, "runId" | "status">): WorkflowRunSummary {
  return {
    workflowName: "w",
    phases: [],
    ...overrides,
  };
}

describe("activity running predicates", () => {
  it("classifies thread statuses", () => {
    expect(isRunningThread("running")).toBe(true);
    expect(isRunningThread("queued")).toBe(true);
    expect(isRunningThread("completed")).toBe(false);
    expect(isRunningThread("failed")).toBe(false);
  });

  it("classifies subagent statuses", () => {
    expect(isRunningSubagent("running")).toBe(true);
    expect(isRunningSubagent("starting")).toBe(true);
    expect(isRunningSubagent("completed")).toBe(false);
    expect(isRunningSubagent("failed")).toBe(false);
  });

  it("classifies workflow statuses", () => {
    expect(isActiveWorkflow("running")).toBe(true);
    expect(isActiveWorkflow("paused")).toBe(true);
    expect(isActiveWorkflow("pending")).toBe(true);
    expect(isActiveWorkflow("completed")).toBe(false);
    expect(isActiveWorkflow("aborted")).toBe(false);
  });
});

describe("activity cwd attribution", () => {
  it("prefers a thread's own cwd, else resolves the owning session", () => {
    expect(threadCwd({ cwd: "/own", sessionFile: "/s.json", parentSessionFile: null }, () => "/other")).toBe("/own");
    expect(threadCwd({ sessionFile: null, parentSessionFile: "/p.json" }, (f) => (f === "/p.json" ? "/proj" : null))).toBe("/proj");
  });

  it("resolves a subagent through its parent session", () => {
    expect(subagentCwd({ parentSessionFile: "/p.json" }, () => "/proj")).toBe("/proj");
    expect(subagentCwd({ sessionFile: "/s.json" }, () => null)).toBeNull();
  });

  it("resolves a workflow through its sessionId", () => {
    const resolve = (id: string | null | undefined) => (id === "s1" ? "/proj" : null);
    expect(workflowCwd({ sessionId: "s1" }, resolve)).toBe("/proj");
    expect(workflowCwd({}, resolve)).toBeNull();
  });

  it("keeps unattributed work visible in any scope", () => {
    expect(inScope("/a", "/a")).toBe(true);
    expect(inScope("/b", "/a")).toBe(false);
    expect(inScope(null, "/a")).toBe(true);
    expect(inScope("/b", null)).toBe(true);
  });
});

describe("countRunningWork", () => {
  const runningThread = thread({ threadId: "t1", status: "running", cwd: "/a" });
  const doneThread = thread({ threadId: "t2", status: "completed", cwd: "/a" });
  const runningSub = subagent({ runId: "r1", status: "running", parentSessionFile: "/s.json" });
  const run = workflowRun({ runId: "w1", status: "running", sessionId: "s1" });
  const doneRun = workflowRun({ runId: "w2", status: "completed" });

  it("counts only running work in scope", () => {
    const n = countRunningWork({
      threads: [runningThread, doneThread],
      subagents: [runningSub],
      workflows: [run, doneRun],
      scope: "/a",
      resolveCwd: () => "/a",
      resolveRunCwd: () => "/a",
    });
    expect(n).toBe(3);
  });

  it("excludes work outside the scope but keeps unattributed work", () => {
    const n = countRunningWork({
      threads: [thread({ threadId: "t3", status: "running", cwd: "/other" })],
      subagents: [],
      workflows: [run],
      scope: "/a",
      resolveRunCwd: () => "/a",
    });
    expect(n).toBe(1);
  });
});
