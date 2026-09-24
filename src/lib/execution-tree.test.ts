import { describe, expect, it, vi } from "vitest";
import {
  aggregateTreeState,
  deriveExecutionTrees,
  openExecutionRoot,
  subagentHoldsExecution,
  threadHoldsExecution,
  workflowHoldsExecution,
  type ExecutionChildNode,
  type ExecutionTree,
} from "./execution-tree";
import type { ProjectExecution } from "../execution";
import type { SessionRuntimeState } from "../sessionRuntime";
import type { SubagentActivity, ThreadActivity, WorkflowRunSummary } from "../bridge";

function exec(over: Partial<ProjectExecution> = {}): ProjectExecution {
  return {
    cwd: "/babylon",
    sessionFile: "/babylon/s1.jsonl",
    sessionId: "s1",
    state: "working",
    streaming: true,
    generation: 1,
    ...over,
  };
}

function runtime(sessionFile: string, over: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
  return {
    sessionId: sessionFile.split("/").pop()?.split(".")[0] ?? "x",
    sessionPath: sessionFile,
    cwd: "/babylon",
    lifecycle: "open",
    execution: "working",
    attention: "none",
    live: true,
    ...over,
  };
}

function subagent(over: Partial<SubagentActivity> = {}): SubagentActivity {
  return { runId: "run-1", status: "running", updatedAt: "2026-01-01T00:00:00.000Z", ...over };
}

function thread(over: Partial<ThreadActivity> = {}): ThreadActivity {
  return {
    threadId: "th-1",
    name: "Explore middleware",
    goal: "",
    status: "running",
    mode: "",
    profile: "",
    model: "",
    parentSessionId: "s1",
    sessionFile: "/babylon/th.jsonl",
    parentSessionFile: "/babylon/s1.jsonl",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    latestSummary: null,
    latestActivity: null,
    filesChanged: [],
    commandsRun: [],
    testsRun: [],
    blocker: null,
    failureReason: null,
    ...over,
  };
}

function workflow(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return { runId: "wf-1", workflowName: "Release checks", status: "running", phases: [], sessionId: "s1", ...over };
}

function derive(over: Partial<Parameters<typeof deriveExecutionTrees>[0]> = {}): ExecutionTree[] {
  return deriveExecutionTrees({
    executions: [],
    runtimeByPath: {},
    threads: [],
    subagents: [],
    workflows: [],
    titleFor: (f) => f.split("/").pop() ?? f,
    ...over,
  });
}

describe("execution-holding predicates", () => {
  it("mirror the backend ownership contracts, not CPU activity", () => {
    // Subagents: exactly the active set.
    expect(subagentHoldsExecution("starting")).toBe(true);
    expect(subagentHoldsExecution("running")).toBe(true);
    expect(subagentHoldsExecution("idle")).toBe(false);
    expect(subagentHoldsExecution("completed")).toBe(false);
    expect(subagentHoldsExecution("interrupted")).toBe(false);
    expect(subagentHoldsExecution("routing_mismatch")).toBe(false);
    // Threads: everything except terminal (spec9 — must match PiHost lock).
    for (const s of ["queued", "starting", "running", "interrupting", "idle", "blocked", "interrupted"] as const) {
      expect(threadHoldsExecution(s)).toBe(true);
    }
    for (const s of ["completed", "failed", "stopped"] as const) {
      expect(threadHoldsExecution(s)).toBe(false);
    }
    // Workflows: pending/running/paused hold; terminals do not.
    expect(workflowHoldsExecution("pending")).toBe(true);
    expect(workflowHoldsExecution("paused")).toBe(true);
    expect(workflowHoldsExecution("completed")).toBe(false);
    expect(workflowHoldsExecution("aborted")).toBe(false);
    expect(workflowHoldsExecution("failed")).toBe(false);
  });
});

describe("aggregateTreeState", () => {
  const child = (state: "working" | "waiting"): ExecutionChildNode => ({
    key: "c",
    kind: "subagent",
    label: "c",
    statusLabel: "Running",
    state,
  });
  it("approval > waiting > working; quiet → null", () => {
    expect(aggregateTreeState("approval", [child("working")])).toBe("approval");
    expect(aggregateTreeState("idle", [child("waiting")])).toBe("waiting");
    expect(aggregateTreeState("working", [child("waiting")])).toBe("waiting"); // waiting outranks working
    expect(aggregateTreeState("idle", [child("working")])).toBe("working"); // main idle + live child
    expect(aggregateTreeState("failed", [child("working")])).toBe("working"); // failed main + live child stays visible
    expect(aggregateTreeState("idle", [])).toBeNull();
    expect(aggregateTreeState("failed", [])).toBeNull(); // failed is not an inbox (spec16)
  });
});

describe("deriveExecutionTrees", () => {
  it("1: one working execution owner → one root", () => {
    const trees = derive({ executions: [exec()], runtimeByPath: { "/babylon/s1.jsonl": runtime("/babylon/s1.jsonl") } });
    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({ sessionId: "s1", state: "working", title: "s1.jsonl", projectName: "babylon" });
    expect(trees[0]?.children).toEqual([]);
  });

  it("2: idle owner with no children → zero roots", () => {
    expect(derive({ executions: [exec({ state: "idle", streaming: false })] })).toHaveLength(0);
  });

  it("3: idle owner + running subagent owned by the root → root visible, working, with the child", () => {
    const trees = derive({
      executions: [exec({ state: "idle", streaming: false })],
      subagents: [subagent({ parentSessionId: "s1" })],
    });
    expect(trees).toHaveLength(1);
    expect(trees[0]?.state).toBe("working");
    expect(trees[0]?.children.map((c) => c.label)).toEqual(["run-1"]);
  });

  it("4: idle owner + paused workflow owned by the root → root waiting", () => {
    const trees = derive({
      executions: [exec({ state: "idle", streaming: false })],
      workflows: [workflow({ status: "paused" })],
    });
    expect(trees).toHaveLength(1);
    expect(trees[0]?.state).toBe("waiting");
    expect(trees[0]?.children[0]).toMatchObject({ statusLabel: "Paused", state: "waiting" });
  });

  it("5: main approval outranks a running child", () => {
    const trees = derive({
      executions: [exec({ state: "approval" })],
      subagents: [subagent({ parentSessionId: "s1" })],
    });
    expect(trees[0]?.state).toBe("approval");
  });

  it("6+19: two busy runtimeByPath sessions in one cwd with ONE owner → exactly one root", () => {
    const trees = derive({
      executions: [exec()],
      runtimeByPath: {
        "/babylon/s1.jsonl": runtime("/babylon/s1.jsonl"),
        "/babylon/other.jsonl": runtime("/babylon/other.jsonl", { sessionId: "other" }),
      },
    });
    expect(trees).toHaveLength(1);
    expect(trees[0]?.sessionId).toBe("s1");
    // Defensive: even a mis-built input with two same-cwd owners yields one root.
    expect(derive({ executions: [exec(), exec({ sessionFile: "/babylon/s2.jsonl", sessionId: "s2" })] })).toHaveLength(1);
  });

  it("7: busy runtimeByPath entry with no execution owner → zero roots", () => {
    expect(derive({ runtimeByPath: { "/babylon/s1.jsonl": runtime("/babylon/s1.jsonl") } })).toHaveLength(0);
  });

  it("8: a same-project child owned by an OLD session never attaches to the current root", () => {
    const trees = derive({
      executions: [exec({ sessionFile: "/babylon/s2.jsonl", sessionId: "s2" })],
      subagents: [subagent({ parentSessionId: "s1" })], // same cwd, old parent
      threads: [thread({ parentSessionId: "s1" })],
      workflows: [workflow({ sessionId: "s1" })],
    });
    expect(trees).toHaveLength(1);
    expect(trees[0]?.children).toEqual([]);
  });

  it("9: subagent attaches by parentSessionId", () => {
    const trees = derive({ executions: [exec()], subagents: [subagent({ parentSessionId: "s1" })] });
    expect(trees[0]?.children).toHaveLength(1);
    expect(trees[0]?.children[0]?.kind).toBe("subagent");
  });

  it("10: falls back to parentSessionFile when the id is unavailable", () => {
    const trees = derive({
      executions: [exec()],
      subagents: [subagent({ parentSessionId: null, parentSessionFile: "/babylon/s1.jsonl" })],
    });
    expect(trees[0]?.children).toHaveLength(1);
    // File mismatch still refuses.
    const miss = derive({
      executions: [exec()],
      subagents: [subagent({ parentSessionId: null, parentSessionFile: "/babylon/old.jsonl" })],
    });
    expect(miss[0]?.children ?? []).toEqual([]);
  });

  it("11: workflow attaches by owning sessionId", () => {
    const trees = derive({ executions: [exec()], workflows: [workflow({ sessionId: "s1" })] });
    expect(trees[0]?.children).toHaveLength(1);
    expect(trees[0]?.children[0]?.kind).toBe("workflow");
  });

  it("12: legacy/global workflow (no sessionId) attaches nowhere and never manufactures a root", () => {
    expect(derive({ runtimeByPath: {}, workflows: [workflow({ sessionId: undefined })] })).toHaveLength(0);
    const withRoot = derive({ executions: [exec({ state: "idle", streaming: false })], workflows: [workflow({ sessionId: undefined })] });
    // The quiet owner stays hidden — the orphan did not revive it (I6).
    expect(withRoot).toHaveLength(0);
  });

  it("13+14: blocked and idle threads attach as waiting (they still lock execution)", () => {
    const trees = derive({
      executions: [exec({ state: "idle", streaming: false })],
      threads: [thread({ status: "blocked" })],
    });
    expect(trees[0]?.children[0]).toMatchObject({ statusLabel: "Blocked", state: "waiting" });
    expect(trees[0]?.state).toBe("waiting");
    const idleTree = derive({
      executions: [exec({ state: "idle", streaming: false })],
      threads: [thread({ status: "idle" })],
    });
    expect(idleTree[0]?.children).toHaveLength(1);
    expect(idleTree[0]?.children[0]?.statusLabel).toBe("Idle");
  });

  it("15: terminal threads (completed/failed/stopped) are excluded", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      const trees = derive({ executions: [exec({ state: "idle", streaming: false })], threads: [thread({ status })] });
      expect(trees).toHaveLength(0); // quiet main + no holding children
    }
  });

  it("16: terminal subagents are excluded", () => {
    for (const status of ["completed", "failed", "stopped", "interrupted", "routing_mismatch", "unknown", "idle"] as const) {
      const trees = derive({ executions: [exec({ state: "idle", streaming: false })], subagents: [subagent({ status })] });
      expect(trees).toHaveLength(0);
    }
  });

  it("17: terminal workflows are excluded", () => {
    for (const status of ["completed", "failed", "aborted"] as const) {
      const trees = derive({ executions: [exec({ state: "idle", streaming: false })], workflows: [workflow({ status })] });
      expect(trees).toHaveLength(0);
    }
  });

  it("18: two projects executing → two roots", () => {
    const trees = derive({
      executions: [
        exec(),
        exec({ cwd: "/rot", sessionFile: "/rot/s9.jsonl", sessionId: "s9" }),
      ],
      runtimeByPath: {
        "/babylon/s1.jsonl": runtime("/babylon/s1.jsonl"),
        "/rot/s9.jsonl": runtime("/rot/s9.jsonl", { cwd: "/rot" }),
      },
    });
    expect(trees).toHaveLength(2);
    expect(new Set(trees.map((t) => t.cwd))).toEqual(new Set(["/babylon", "/rot"]));
  });

  it("20: deterministic order regardless of input order (urgency → active Space → project → title)", () => {
    const working = exec();
    const waiting = exec({ cwd: "/other", sessionFile: "/other/w.jsonl", sessionId: "w", state: "waiting", streaming: false });
    const rt = {
      "/babylon/s1.jsonl": runtime("/babylon/s1.jsonl"),
      "/other/w.jsonl": runtime("/other/w.jsonl", { cwd: "/other", execution: "waiting", live: false }),
    };
    const a = derive({ executions: [working, waiting], runtimeByPath: rt, activeCwd: "/other" });
    const b = derive({ executions: [waiting, working], runtimeByPath: rt, activeCwd: "/other" });
    // Waiting outranks working; within urgency the active Space leads.
    expect(a.map((t) => t.sessionId)).toEqual(["w", "s1"]);
    expect(b.map((t) => t.sessionId)).toEqual(["w", "s1"]);
    // Space-first only BREAKS urgency ties: two same-urgency roots.
    const working2 = exec({ cwd: "/other", sessionFile: "/other/w2.jsonl", sessionId: "w2", streaming: false });
    const rt2 = { ...rt, "/other/w2.jsonl": runtime("/other/w2.jsonl", { cwd: "/other", execution: "working", live: false }) };
    const activeFirst = derive({ executions: [working, working2], runtimeByPath: rt2, activeCwd: "/other" });
    expect(activeFirst.map((t) => t.sessionId)).toEqual(["w2", "s1"]);
    expect(derive({ executions: [working, working2], runtimeByPath: rt2, activeCwd: "/babylon" }).map((t) => t.sessionId)).toEqual(["s1", "w2"]);
  });

  it("children sort: blocked/paused before running, then starting/queued", () => {
    const trees = derive({
      executions: [exec()],
      threads: [
        thread({ threadId: "t2", name: "q", status: "queued", parentSessionId: "s1" }),
        thread({ threadId: "t1", name: "r", status: "running", parentSessionId: "s1" }),
        thread({ threadId: "t3", name: "b", status: "blocked", parentSessionId: "s1" }),
      ],
      subagents: [subagent({ runId: "run-a", parentSessionId: "s1", status: "starting" })],
    });
    expect(trees[0]?.children.map((c) => c.statusLabel)).toEqual(["Blocked", "Running", "Starting", "Queued"]);
  });

  it("root carries enriched attention from runtimeByPath (ownership from the registry)", () => {
    const trees = derive({
      executions: [exec()],
      runtimeByPath: { "/babylon/s1.jsonl": runtime("/babylon/s1.jsonl", { attention: "approval" }) },
    });
    expect(trees[0]?.attention).toBe("approval");
    // runtimeByPath cannot override registry STATE upward into visibility:
    expect(derive({ runtimeByPath: { "/babylon/s1.jsonl": runtime("/babylon/s1.jsonl") } })).toHaveLength(0);
  });
});

describe("openExecutionRoot", () => {
  const tree: Pick<ExecutionTree, "sessionFile" | "cwd"> = { sessionFile: "/babylon/s1.jsonl", cwd: "/babylon" };

  it("views the owning session only — never activation APIs", () => {
    const bridge = { openSession: vi.fn(), executionActivate: vi.fn(), releaseSession: vi.fn() };
    const viewSession = vi.fn();
    const onBeforeView = vi.fn();
    openExecutionRoot({ viewSession, onBeforeView, bridge }, tree);
    expect(onBeforeView).toHaveBeenCalledTimes(1);
    expect(viewSession).toHaveBeenCalledWith("/babylon/s1.jsonl", "/babylon");
    expect(bridge.openSession).not.toHaveBeenCalled();
    expect(bridge.executionActivate).not.toHaveBeenCalled();
    expect(bridge.releaseSession).not.toHaveBeenCalled();
  });
});
