import { describe, expect, it } from "vitest";
import {
  applyRuntimeEvent,
  assembleRuntimeState,
  canSettle,
  compareSettled,
  computeRuntimeByPath,
  deriveAttention,
  deriveSpaceAttention,
  emptyExecutions,
  formatRunDuration,
  isLiveExecution,
  maxAttention,
  mergeSourceExecutions,
  resolveApprovalExecution,
  resolveApprovalPath,
  resolveRuntimePath,
  statusDotKind,
  strongerExecution,
} from "./sessionRuntime";
import { createAttentionRegistry } from "./attention";
import type { ProjectExecution } from "./execution";

const CTX = (path: string | null, seq: number) => ({ path, seq, now: 1000 + seq * 10 });
const owner = (cwd: string, sessionFile: string, state: ProjectExecution["state"]): ProjectExecution => ({
  cwd,
  sessionFile,
  sessionId: sessionFile === "/a.json" ? "sid-fresh".replace("sid-fresh", "s1") : "sid-fresh",
  state,
  streaming: state === "working",
  generation: 1,
});

describe("applyRuntimeEvent", () => {
  it("marks a session working on agent_start with a start timestamp", () => {
    const next = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    expect(next["/a.json"]?.execution).toBe("working");
    expect(next["/a.json"]?.startedAt).toBe(1010);
  });

  it("clears to idle on agent_settled (completion removes live status)", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    m = applyRuntimeEvent(m, { type: "agent_settled" }, CTX("/a.json", 2));
    expect(m["/a.json"]?.execution).toBe("idle");
    expect(m["/a.json"]?.startedAt).toBeNull();
  });

  it("abort clears activity via the aborted settle event", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    m = applyRuntimeEvent(m, { type: "agent_settled" }, CTX("/a.json", 2));
    expect(m["/a.json"]?.execution).toBe("idle");
  });

  it("an immediate next run reuses the same single entry with a fresh timestamp", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    m = applyRuntimeEvent(m, { type: "agent_settled" }, CTX("/a.json", 2));
    m = applyRuntimeEvent(m, { type: "agent_start" }, CTX("/a.json", 3));
    expect(Object.keys(m)).toEqual(["/a.json"]);
    expect(m["/a.json"]?.execution).toBe("working");
    expect(m["/a.json"]?.startedAt).toBe(1030);
  });

  it("keeps background sessions live under their own path (switch-safe)", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    m = applyRuntimeEvent(m, { type: "agent_start" }, CTX("/b.json", 2));
    m = applyRuntimeEvent(m, { type: "agent_settled" }, CTX("/b.json", 3));
    expect(m["/a.json"]?.execution).toBe("working");
    expect(m["/b.json"]?.execution).toBe("idle");
  });

  it("stale (older-or-equal sequence) events cannot resurrect cleared activity", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 5));
    m = applyRuntimeEvent(m, { type: "agent_settled" }, CTX("/a.json", 6));
    m = applyRuntimeEvent(m, { type: "agent_start" }, CTX("/a.json", 5));
    m = applyRuntimeEvent(m, { type: "agent_start" }, CTX("/a.json", 6));
    expect(m["/a.json"]?.execution).toBe("idle");
  });

  it("tracks approval requests and returns to working on cancel", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    m = applyRuntimeEvent(m, { type: "extension_ui_request" }, CTX("/a.json", 2));
    expect(m["/a.json"]?.execution).toBe("approval");
    m = applyRuntimeEvent(m, { type: "extension_ui_cancel" }, CTX("/a.json", 3));
    expect(m["/a.json"]?.execution).toBe("working");
  });

  it("cancel after settle does not resurrect activity", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    m = applyRuntimeEvent(m, { type: "agent_settled" }, CTX("/a.json", 2));
    m = applyRuntimeEvent(m, { type: "extension_ui_cancel" }, CTX("/a.json", 3));
    expect(m["/a.json"]?.execution).toBe("idle");
  });

  it("resolveApprovalExecution resumes an approval entry, ignores others", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "extension_ui_request" }, CTX("/a.json", 1));
    m = resolveApprovalExecution(m, "/a.json", 2, 2000);
    expect(m["/a.json"]?.execution).toBe("working");
    const idle = resolveApprovalExecution(emptyExecutions(), "/b.json", 3, 2000);
    expect(idle).toEqual({});
  });

  it("ignores unresolvable paths and unknown event types", () => {
    expect(applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX(null, 1))).toEqual({});
    expect(applyRuntimeEvent(emptyExecutions(), { type: "message_update" }, CTX("/a.json", 1))).toEqual({});
    expect(applyRuntimeEvent(emptyExecutions(), null, CTX("/a.json", 1))).toEqual({});
  });
});

describe("strongerExecution", () => {
  it("orders approval > waiting > working > failed > idle", () => {
    expect(strongerExecution("idle", "failed")).toBe("failed");
    expect(strongerExecution("failed", "working")).toBe("working");
    expect(strongerExecution("working", "waiting")).toBe("waiting");
    expect(strongerExecution("waiting", "approval")).toBe("approval");
    expect(strongerExecution("working", "idle")).toBe("working");
  });
});

describe("deriveAttention", () => {
  it("prefers approval over unread", () => {
    expect(deriveAttention({ approval: true, unread: true })).toBe("approval");
    expect(deriveAttention({ approval: false, unread: true })).toBe("unread");
    expect(deriveAttention({ approval: false, unread: false })).toBe("none");
  });
});

describe("attention priority", () => {
  it("orders approval > unread > none across a project", () => {
    expect(maxAttention("none", "unread")).toBe("unread");
    expect(maxAttention("unread", "approval")).toBe("approval");
    expect(deriveSpaceAttention(["none", "none", "unread"])).toBe("unread");
    expect(deriveSpaceAttention(["unread", "approval", "none"])).toBe("approval");
    expect(deriveSpaceAttention([])).toBe("none");
  });

  it("picks one dot per compact row", () => {
    expect(statusDotKind("approval", false)).toBe("approval");
    expect(statusDotKind("waiting", false)).toBe("approval");
    expect(statusDotKind("failed", true)).toBe("failed");
    expect(statusDotKind("idle", true)).toBe("unread");
    expect(statusDotKind("working", false)).toBe("live");
    expect(statusDotKind("idle", false)).toBeNull();
    expect(statusDotKind("working", true)).toBe("unread");
  });
});

describe("assembleRuntimeState", () => {
  it("derives live from execution and carries identity", () => {
    const s = assembleRuntimeState({
      sessionId: "s1",
      sessionPath: "/a.json",
      cwd: "/proj",
      lifecycle: "open",
      execution: "working",
      attention: "none",
      startedAt: 999,
      botId: "b1",
    });
    expect(s.live).toBe(true);
    expect(s.botId).toBe("b1");
    expect(assembleRuntimeState({ ...s, execution: "idle" }).live).toBe(false);
  });

  it("isLiveExecution is false only for idle", () => {
    expect(isLiveExecution("idle")).toBe(false);
    for (const e of ["working", "waiting", "approval", "failed"] as const)
      expect(isLiveExecution(e)).toBe(true);
  });
});

describe("settlement helpers", () => {
  it("blocks settle while working/waiting/approval, allows idle/failed", () => {
    expect(canSettle("working")).toBe(false);
    expect(canSettle("waiting")).toBe(false);
    expect(canSettle("approval")).toBe(false);
    expect(canSettle("idle")).toBe(true);
    expect(canSettle("failed")).toBe(true);
  });

  it("orders settled newest-first on the settled timestamp", () => {
    const rows = [
      { path: "/old.json", at: 100 },
      { path: "/new.json", at: 300 },
      { path: "/mid.json", at: 200 },
    ].sort(compareSettled);
    expect(rows.map((r) => r.path)).toEqual(["/new.json", "/mid.json", "/old.json"]);
  });
});

describe("resolveRuntimePath", () => {
  const ids = new Map([["s1", "/a.json"]]);
  it("resolves a session through the id map", () => {
    expect(resolveRuntimePath("s1", ids, true)).toBe("/a.json");
  });
  it("drops unknown ids instead of attributing them to whatever is viewed", () => {
    expect(resolveRuntimePath("nope", ids, true)).toBeNull();
    expect(resolveRuntimePath("nope", ids, false)).toBeNull();
  });
  it("has no fallback for unstamped events: identity is required", () => {
    expect(resolveRuntimePath(null, ids, false)).toBeNull();
  });
});

describe("resolveApprovalPath", () => {
  const ids = new Map([["s1", "/a.json"]]);
  it("resolves through the request's own session id", () => {
    expect(resolveApprovalPath("s1", ids)).toBe("/a.json");
  });
  it("never falls back to a viewed path when identity is missing or unknown", () => {
    expect(resolveApprovalPath(null, ids)).toBeNull();
    expect(resolveApprovalPath(undefined, ids)).toBeNull();
    expect(resolveApprovalPath("nope", ids)).toBeNull();
  });
});

describe("reconnect", () => {
  const working = (seq: number) => ({ execution: "working" as const, startedAt: 1, seq });
  it("keeps per-path event state for every project, not just the viewed one", () => {
    // Several Spaces can execute at once: a reconnect may not prune the
    // background owner's row just because the user is looking elsewhere.
    const prev = { "/a.json": working(1), "/b.json": working(2) };
    expect(Object.keys(prev)).toEqual(["/a.json", "/b.json"]);
  });
  it("aborted settle clears like any settle", () => {
    let m = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    m = applyRuntimeEvent(m, { type: "agent_settled" }, CTX("/a.json", 2));
    expect(m["/a.json"]?.execution).toBe("idle");
  });
});

describe("formatRunDuration", () => {
  it("formats compact durations", () => {
    expect(formatRunDuration(5000)).toBe("5s");
    expect(formatRunDuration(32000)).toBe("32s");
    expect(formatRunDuration(4 * 60_000)).toBe("4m");
    expect(formatRunDuration(62 * 60_000)).toBe("1h2m");
    expect(formatRunDuration(2 * 3600_000)).toBe("2h");
  });
});

describe("mergeSourceExecutions", () => {
  const resolve = (sid?: string) => (sid === "s1" ? "/a.json" : sid === "s2" ? "/b.json" : undefined);
  it("marks owning sessions across projects without touching others", () => {
    const out = mergeSourceExecutions(
      { "/a.json": "idle", "/b.json": "idle" },
      {
        threads: [{ status: "running", sessionFile: "/a.json" }],
        subagents: [{ status: "running", sessionFile: "/b.json", parentSessionFile: "/a.json" }],
        workflows: [],
      },
      resolve
    );
    expect(out).toEqual({ "/a.json": "working", "/b.json": "working" });
  });

  it("never clears: absent and terminal sources leave entries alone", () => {
    expect(mergeSourceExecutions({ "/a.json": "working" }, { threads: [], subagents: [], workflows: [] }, resolve))
      .toEqual({ "/a.json": "working" });
    expect(
      mergeSourceExecutions(
        { "/a.json": "working" },
        { threads: [], subagents: [{ status: "completed", sessionFile: "/a.json" }], workflows: [] },
        resolve
      )
    ).toEqual({ "/a.json": "working" });
  });

  it("maps interrupted/failed to failed and paused workflows to waiting", () => {
    const out = mergeSourceExecutions(
      {},
      {
        threads: [{ status: "interrupted", sessionFile: "/a.json" }],
        subagents: [{ status: "failed", sessionFile: "/b.json" }],
        workflows: [{ status: "paused", sessionId: "s1" }],
      },
      resolve
    );
    // waiting outranks failed on the shared path; failed stands alone.
    expect(out).toEqual({ "/a.json": "waiting", "/b.json": "failed" });
  });

  it("ignores unresolvable workflow sessions", () => {
    expect(
      mergeSourceExecutions({ "/a.json": "idle" }, { threads: [], subagents: [], workflows: [{ status: "running", sessionId: "nope" }] }, resolve)
    ).toEqual({ "/a.json": "idle" });
  });
});

describe("computeRuntimeByPath", () => {
  const groups = [{ cwd: "/p", sessions: [{ id: "s1", path: "/a.json", cwd: "/p" }] }];
  const base = () => ({
    groups,
    executions: emptyExecutions(),
    settled: {} as Record<string, number>,
    unread: [] as string[],
    attention: createAttentionRegistry(),
    activity: { threads: [], subagents: [] },
    workflowRuns: [],
    viewedSessionPath: null as string | null,
    viewedCwd: null as string | null,
    projectExecutions: [] as ProjectExecution[],
    bots: [] as Array<{ id: string; mainSessionFile: string | null; sessionsByProject?: Record<string, string> }>,
  });

  it("creates an entry per session with open lifecycle", () => {
    const map = computeRuntimeByPath(base());
    expect(map["/a.json"]?.lifecycle).toBe("open");
    expect(map["/a.json"]?.execution).toBe("idle");
    expect(map["/a.json"]?.live).toBe(false);
  });

  it("marks settled lifecycle from the settled map", () => {
    const map = computeRuntimeByPath({ ...base(), settled: { "/a.json": 123 } });
    expect(map["/a.json"]?.lifecycle).toBe("settled");
  });

  it("escalates execution from the event layer and carries startedAt", () => {
    const executions = applyRuntimeEvent(emptyExecutions(), { type: "agent_start" }, CTX("/a.json", 1));
    const map = computeRuntimeByPath({ ...base(), executions });
    expect(map["/a.json"]?.execution).toBe("working");
    expect(map["/a.json"]?.startedAt).toBe(1010);
    expect(map["/a.json"]?.live).toBe(true);
  });

  it("marks the project's owner working from the execution registry alone", () => {
    const map = computeRuntimeByPath({
      ...base(),
      viewedSessionPath: "/a.json",
      projectExecutions: [owner("/p", "/a.json", "working")],
    });
    expect(map["/a.json"]?.execution).toBe("working");
  });

  it("never marks a viewed historical session working while another owner runs", () => {
    // The core C11 routing proof: A executes, B is on screen, and B's row
    // stays idle. No global streaming boolean can touch it.
    const groupsTwo = [
      { sessions: [
        { id: "sA", path: "/a.json", cwd: "/p" },
        { id: "sB", path: "/b.json", cwd: "/p" },
      ] },
    ];
    const map = computeRuntimeByPath({
      ...base(),
      groups: groupsTwo,
      viewedSessionPath: "/b.json",
      projectExecutions: [owner("/p", "/a.json", "working")],
    });
    expect(map["/a.json"]?.execution).toBe("working");
    expect(map["/b.json"]?.execution).toBe("idle");
  });

  it("creates rows for fresh unindexed execution owners", () => {
    const map = computeRuntimeByPath({
      ...base(),
      groups: [],
      projectExecutions: [owner("/p", "/fresh.json", "idle")],
    });
    expect(map["/fresh.json"]?.sessionId).toBe("sid-fresh");
    expect(map["/fresh.json"]?.cwd).toBe("/p");
  });

  it("keeps two projects' owners working at once", () => {
    const map = computeRuntimeByPath({
      ...base(),
      groups: [
        { sessions: [{ id: "s1", path: "/a.json", cwd: "/p1" }] },
        { sessions: [{ id: "s2", path: "/c.json", cwd: "/p2" }] },
      ],
      viewedSessionPath: "/a.json",
      projectExecutions: [owner("/p1", "/a.json", "working"), owner("/p2", "/c.json", "approval")],
    });
    expect(map["/a.json"]?.execution).toBe("working");
    expect(map["/c.json"]?.execution).toBe("approval");
  });

  it("derives unread and approval attention", () => {
    const unreadMap = computeRuntimeByPath({ ...base(), unread: ["/a.json"] });
    expect(unreadMap["/a.json"]?.attention).toBe("unread");

    const attention = createAttentionRegistry();
    attention.items["perm-1"] = {
      id: "perm-1",
      type: "permission",
      title: "needs approval",
      source: "/a.json",
      createdAt: 1,
      resolved: false,
    };
    const approvalMap = computeRuntimeByPath({ ...base(), attention });
    expect(approvalMap["/a.json"]?.attention).toBe("approval");
  });

  it("attributes a bot by project session", () => {
    const map = computeRuntimeByPath({
      ...base(),
      bots: [{ id: "b1", mainSessionFile: null, sessionsByProject: { p: "/a.json" } }],
    });
    expect(map["/a.json"]?.botId).toBe("b1");
  });

  it("escalates from thread snapshots keyed by session path", () => {
    const map = computeRuntimeByPath({
      ...base(),
      activity: { threads: [{ status: "running", sessionFile: "/a.json" }], subagents: [] },
    });
    expect(map["/a.json"]?.execution).toBe("working");
  });
});

describe("extension_ui_response", () => {
  it("releases an approval gate back to working when a dialog is answered", () => {
    const waiting = applyRuntimeEvent(emptyExecutions(), { type: "extension_ui_request" }, CTX("/a.json", 1));
    expect(waiting["/a.json"]?.execution).toBe("approval");
    const answered = applyRuntimeEvent(waiting, { type: "extension_ui_response" }, CTX("/a.json", 2));
    expect(answered["/a.json"]?.execution).toBe("working");
  });

  it("does not resurrect a run that already settled", () => {
    const idle = applyRuntimeEvent(emptyExecutions(), { type: "agent_settled" }, CTX("/a.json", 1));
    const after = applyRuntimeEvent(idle, { type: "extension_ui_response" }, CTX("/a.json", 2));
    expect(after).toBe(idle);
  });
});
