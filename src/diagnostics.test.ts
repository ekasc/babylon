import { describe, expect, it } from "vitest";
import { collectDiagnostics, exportDiagnostics } from "./diagnostics";
import { createAttentionRegistry, addAttention } from "./attention";
import { createRegistry, createProcess, terminateProcess, type ProcessRegistry } from "./process-model";
import { createScheduledTaskRegistry, registerScheduledTask } from "./automation";
import { createAutomationHistory } from "./automation-runner";
import { defaultPolicy } from "./background-policy";
import { createDeviceRegistry, pairDevice } from "./device-pairing";
import { hashToken } from "./remote-auth";
import { appendEvent, createEventLog, type BabylonEvent } from "./events";

describe("runtime diagnostics", () => {
  it("aggregates registry state without leaking content", () => {
    let attention = addAttention(createAttentionRegistry(), {
      id: "a1",
      type: "permission",
      title: "SECRET-TITLE git push",
      detail: "token=abc123",
      createdAt: 1,
      resolved: false,
    });
    attention = addAttention(attention, {
      id: "a2",
      type: "failed_task",
      title: "done thing",
      createdAt: 2,
      resolved: true,
    });
    let processes: ProcessRegistry = createRegistry();
    processes = createProcess(processes, { id: "p1", command: "pnpm dev --secret", cwd: "/proj" });
    processes = createProcess(processes, { id: "p2", command: "vitest", cwd: "/proj" });
    processes = terminateProcess(processes, "p2", { exitCode: 0 });
    const schedule = registerScheduledTask(createScheduledTaskRegistry(), {
      id: "s1",
      name: "deps",
      enabled: true,
      trigger: { kind: "interval", intervalMs: 60_000 },
      runCount: 0,
    });
    const history = {
      runs: [
        {
          id: "r1",
          taskId: "s1",
          taskName: "deps",
          startedAt: 1,
          finishedAt: 1,
          status: "succeeded" as const,
        },
      ],
    };
    let devices = pairDevice(createDeviceRegistry(), {
      id: "d1",
      name: "phone",
      scope: ["view_tasks"],
      tokenHash: hashToken("tok"),
      now: 1,
    });
    if (typeof devices === "string") throw new Error(devices);

    const snapshot = collectDiagnostics({
      now: 100,
      appVersion: "0.1.0",
      attention,
      processes,
      schedule,
      history,
      policy: defaultPolicy(),
      devices,
    });

    expect(snapshot).toMatchObject({
      runtimeVersion: 1,
      attention: { unresolved: 1 },
      processes: { active: 1, exited: 1 },
      automation: { scheduledTasks: 1, enabledTasks: 1, recordedRuns: 1 },
      backgroundPolicy: { mode: "while_plugged_in" },
      devices: { paired: 1, revoked: 0 },
    });

    // The export is aggregates only: no titles, details, commands, or hashes.
    const exported = exportDiagnostics(snapshot);
    for (const forbidden of ["SECRET-TITLE", "token=abc123", "pnpm dev", "/proj", hashToken("tok"), "deps"]) {
      expect(exported).not.toContain(forbidden);
    }
  });

  it("reports event health and ownership coverage", () => {
    let log = createEventLog();
    const events: BabylonEvent[] = [
      { id: "e1", type: "task.blocked", ts: 10, owner: { taskId: "t1", projectId: "p1" }, payload: {} },
      { id: "e2", type: "message.sent", ts: 20, owner: { sessionId: "s1" }, payload: {} },
    ];
    for (const e of events) {
      const out = appendEvent(log, e);
      if (typeof out === "string") throw new Error(out);
      log = out;
    }
    const snapshot = collectDiagnostics({ now: 30, events: log });
    expect(snapshot.events).toMatchObject({
      total: 2,
      firstTs: 10,
      lastTs: 20,
      ownershipCoverage: { taskId: 1, sessionId: 1 },
    });
    expect(snapshot.events?.byType["task.blocked"]).toBe(1);
  });

  it("reports observed vs unobserved event types as runtime visibility", () => {
    let log = createEventLog();
    const events: BabylonEvent[] = [
      { id: "e1", type: "message.sent", ts: 10, owner: { sessionId: "s1" }, payload: {} },
      { id: "e2", type: "turn.completed", ts: 20, owner: { sessionId: "s1" }, payload: {} },
    ];
    for (const e of events) {
      const out = appendEvent(log, e);
      if (typeof out === "string") throw new Error(out);
      log = out;
    }
    const snapshot = collectDiagnostics({ now: 30, events: log });
    expect(snapshot.events?.observedTypes).toEqual(["message.sent", "turn.completed"]);
    // Every catalog type is accounted for exactly once across the two lists.
    expect(snapshot.events?.unobservedTypes).toContain("process.started");
    expect(snapshot.events?.unobservedTypes).not.toContain("message.sent");
    expect(snapshot.events!.observedTypes.length + snapshot.events!.unobservedTypes.length).toBe(16);
    // Unobserved is session visibility, not a defect claim: the label lives in
    // the panel; here we only assert the data stays factual.
    const exported = exportDiagnostics(snapshot);
    expect(exported).toContain("unobservedTypes");
  });

  it("keeps the privacy guarantee intact under the typed payload contracts", () => {
    let log = createEventLog();
    const events: BabylonEvent[] = [
      {
        id: "e1",
        type: "approval.resolved",
        ts: 10,
        owner: {},
        payload: { id: "a1", decision: "deny" },
      },
      {
        id: "e2",
        type: "tool.completed",
        ts: 20,
        owner: { sessionId: "s1", toolRunId: "c1" },
        payload: { toolCallId: "c1", isError: false },
      },
    ];
    for (const e of events) {
      const out = appendEvent(log, e);
      if (typeof out === "string") throw new Error(out);
      log = out;
    }
    const exported = exportDiagnostics(collectDiagnostics({ now: 30, events: log }));
    // The export is aggregates only: no payload values (ids, decisions, flags)
    // and never any content.
    for (const forbidden of ["rm -rf", "token", "prompt text", "MUTATED", '"a1"', '"c1"', "deny"]) {
      expect(exported).not.toContain(forbidden);
    }
    expect(exported).toContain('"approval.resolved": 1');
  });

  it("produces stable, sorted exports", () => {
    const a = collectDiagnostics({ now: 1, policy: defaultPolicy() });
    const b = collectDiagnostics({ now: 1, policy: defaultPolicy() });
    expect(exportDiagnostics(a)).toBe(exportDiagnostics(b));
    const keys = Object.keys(JSON.parse(exportDiagnostics(a)));
    expect(keys).toEqual([...keys].sort());
  });
});
