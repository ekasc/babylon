import { describe, expect, it } from "vitest";
import {
  EXECUTION_INVARIANTS,
  ProjectExecutionBusyError,
  deriveExecutionState,
  isExecutionBusyState,
  isProjectExecutionBusy,
} from "./execution";

describe("execution terminology contract", () => {
  it("documents all ten invariants", () => {
    expect(EXECUTION_INVARIANTS).toHaveLength(10);
    expect(EXECUTION_INVARIANTS[0]).toContain("at most one top-level execution session");
    expect(EXECUTION_INVARIANTS[2]).toContain("never changes execution ownership");
    expect(EXECUTION_INVARIANTS[4]).toContain("never controls execution lifetime");
    expect(EXECUTION_INVARIANTS[7]).toContain("never an ownership fallback");
    expect(EXECUTION_INVARIANTS[9]).toContain("never the viewed session");
  });
});

describe("deriveExecutionState", () => {
  it("maps flags to the five states with approval and failed dominating", () => {
    expect(deriveExecutionState({ streaming: false, approvalPending: false, waitingForInput: false, failed: false })).toBe("idle");
    expect(deriveExecutionState({ streaming: true, approvalPending: false, waitingForInput: false, failed: false })).toBe("working");
    expect(deriveExecutionState({ streaming: false, approvalPending: false, waitingForInput: true, failed: false })).toBe("waiting");
    expect(deriveExecutionState({ streaming: true, approvalPending: true, waitingForInput: false, failed: false })).toBe("approval");
    expect(deriveExecutionState({ streaming: false, approvalPending: false, waitingForInput: false, failed: true })).toBe("failed");
    // Approval dominates streaming: a blocked agent is waiting on the human.
    expect(deriveExecutionState({ streaming: true, approvalPending: true, waitingForInput: true, failed: false })).toBe("approval");
  });
});

describe("isExecutionBusyState", () => {
  it("busy means working/waiting/approval; failed and idle owners may be replaced", () => {
    expect(isExecutionBusyState("working")).toBe(true);
    expect(isExecutionBusyState("waiting")).toBe(true);
    expect(isExecutionBusyState("approval")).toBe(true);
    expect(isExecutionBusyState("idle")).toBe(false);
    expect(isExecutionBusyState("failed")).toBe(false);
  });
});

describe("ProjectExecutionBusyError", () => {
  it("carries the busy owner's identity and a stable code", () => {
    const err = new ProjectExecutionBusyError("/s/a1.jsonl", "session-1");
    expect(err.code).toBe("PROJECT_EXECUTION_BUSY");
    expect(err.busySessionFile).toBe("/s/a1.jsonl");
    expect(err.busySessionId).toBe("session-1");
    expect(err.message).toContain("/s/a1.jsonl");
    expect(isProjectExecutionBusy(err)).toBe(true);
    // Serialized-across-IPC form matches the class form (message-only
    // boundaries may strip the prototype).
    expect(isProjectExecutionBusy({ code: "PROJECT_EXECUTION_BUSY" })).toBe(true);
    expect(isProjectExecutionBusy(new Error("other"))).toBe(false);
    expect(isProjectExecutionBusy(null)).toBe(false);
  });
});

describe("execution wire envelopes", () => {
  const execution = {
    cwd: "/proj/a",
    sessionFile: "/s/a1.jsonl",
    sessionId: "session-a1",
    state: "working" as const,
    streaming: true,
    generation: 3,
  };

  it("unwraps the list, activate, and deactivate payloads", async () => {
    const mod = await import("./execution");
    expect(mod.unwrapExecutionListResult({ executions: [execution] }, "t")).toEqual([execution]);
    expect(mod.unwrapExecutionListResult({ executions: [] }, "t")).toEqual([]);
    expect(mod.unwrapExecutionActivateResult({ ok: true, execution }, "t")).toEqual({ ok: true, execution });
    expect(
      mod.unwrapExecutionActivateResult(
        { ok: false, code: "PROJECT_EXECUTION_BUSY", busySessionFile: "/s/a0.jsonl", busySessionId: "s0" },
        "t"
      )
    ).toEqual({ ok: false, code: "PROJECT_EXECUTION_BUSY", busySessionFile: "/s/a0.jsonl", busySessionId: "s0" });
    expect(mod.unwrapExecutionDeactivateResult({ released: true }, "t")).toBe(true);
    expect(mod.unwrapExecutionDeactivateResult({ released: false }, "t")).toBe(false);
  });

  it("converts only busy errors to the activation envelope", async () => {
    const mod = await import("./execution");
    const busy = new ProjectExecutionBusyError("/s/a1.jsonl", "session-a1");
    expect(mod.toExecutionActivateResult(busy)).toEqual({
      ok: false,
      code: "PROJECT_EXECUTION_BUSY",
      busySessionFile: "/s/a1.jsonl",
      busySessionId: "session-a1",
    });
    expect(mod.toExecutionActivateResult(new Error("other"))).toBeNull();
  });

  it("fails loud on malformed envelopes (no silent fallbacks)", async () => {
    const mod = await import("./execution");
    const badList = [
      null,
      {},
      { executions: "nope" },
      { executions: [{ ...execution, state: "potato" }] },
      { executions: [{ ...execution, generation: "3" }] },
    ];
    for (const payload of badList) {
      expect(() => mod.unwrapExecutionListResult(payload, "t")).toThrow(/malformed/);
    }
    const badActivate = [
      null,
      { ok: "yes", execution },
      { ok: true },
      { ok: true, execution: { ...execution, streaming: "yes" } },
      { ok: false, code: "PROJECT_EXECUTION_BUSY", busySessionFile: "/s/a0.jsonl" }, // missing busySessionId
      { ok: false, code: "OTHER" },
      { execution }, // missing ok
    ];
    for (const payload of badActivate) {
      expect(() => mod.unwrapExecutionActivateResult(payload, "t")).toThrow(/malformed/);
    }
    expect(() => mod.unwrapExecutionDeactivateResult({}, "t")).toThrow(/malformed/);
    expect(() => mod.unwrapExecutionDeactivateResult({ released: "yes" }, "t")).toThrow(/malformed/);
  });
});
