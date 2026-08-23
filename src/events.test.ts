import { describe, expect, it } from "vitest";
import {
  appendEvent,
  createBabylonEvent,
  createEventLog,
  listEvents,
  newEventId,
  validateEvent,
  type BabylonEvent,
} from "./events";
import { ownershipCoverage, projectEvents } from "./event-projection";

function event(partial: Partial<BabylonEvent> & { id: string; type: BabylonEvent["type"] }): BabylonEvent {
  return { ts: 1, owner: {}, payload: {}, ...partial };
}

describe("event model", () => {
  it("appends valid events and rejects duplicates", () => {
    let log = createEventLog();
    const e1 = event({ id: "e1", type: "turn.started", ts: 10 });
    const appended = appendEvent(log, e1);
    expect(typeof appended).not.toBe("string");
    log = appended as ReturnType<typeof createEventLog>;
    expect(appendEvent(log, event({ id: "e1", type: "turn.started", ts: 11 }))).toMatch(/already exists/);
    expect(log.events).toHaveLength(1);
  });

  it("normalizes ids by trimming before the duplicate check", () => {
    let log = createEventLog();
    const out = appendEvent(log, event({ id: "  e1  ", type: "turn.started" }));
    expect(typeof out).not.toBe("string");
    log = out as ReturnType<typeof createEventLog>;
    expect(log.events[0].id).toBe("e1");
    // " e1 " and "e1" are the same id once trimmed.
    expect(appendEvent(log, event({ id: " e1 ", type: "turn.completed" }))).toMatch(/already exists/);
  });

  it("rejects malformed events with actionable reasons", () => {
    expect(validateEvent(null)).toMatch(/object/);
    expect(validateEvent({ id: "", type: "turn.started", ts: 1 })).toMatch(/non-empty id/);
    expect(validateEvent({ id: "   ", type: "turn.started", ts: 1 })).toMatch(/non-empty id/);
    expect(validateEvent({ id: "x", type: "turn.exploded", ts: 1 })).toMatch(/unknown event type/);
    expect(validateEvent({ id: "x", type: "turn.started", ts: Number.NaN })).toMatch(/finite ts/);
    expect(validateEvent({ id: "x", type: "turn.started", ts: 1, payload: 5 })).toMatch(/payload/);
    expect(validateEvent({ id: "x", type: "turn.started", ts: 1, owner: { horseId: "h" } })).toMatch(/ownership key/);
    expect(validateEvent({ id: "x", type: "turn.started", ts: 1, owner: { taskId: "" } })).toMatch(/non-empty string/);
  });

  it("enforces per-type payload contracts", () => {
    // Subject-based events require their entity id.
    expect(
      validateEvent(event({ id: "x", type: "attention.created", payload: {} }))
    ).toMatch(/requires non-empty id/);
    expect(
      validateEvent(event({ id: "x", type: "plan.approved", payload: { id: "" } }))
    ).toMatch(/requires non-empty id/);
    expect(
      validateEvent(event({ id: "x", type: "approval.resolved", payload: { id: "a1" } }))
    ).toMatch(/requires non-empty decision/);
    // Optional fields must have the declared type when present.
    expect(
      validateEvent(event({ id: "x", type: "process.exited", payload: { exitCode: "zero" } }))
    ).toMatch(/exitCode must be number/);
    expect(
      validateEvent(event({ id: "x", type: "tool.completed", payload: { toolCallId: 7 } }))
    ).toMatch(/toolCallId must be string/);
    // Valid contract payloads pass.
    expect(
      validateEvent(event({ id: "x", type: "approval.resolved", payload: { id: "a1", decision: "deny" } }))
    ).toBeNull();
  });

  it("rejects non-primitive payload values so payloads stay export-safe", () => {
    expect(
      validateEvent(event({ id: "x", type: "task.blocked", payload: { reason: ["policy"] } }))
    ).toMatch(/must be a primitive/);
    expect(
      validateEvent(event({ id: "x", type: "message.sent", payload: { nested: { deep: true } } }))
    ).toMatch(/must be a primitive/);
  });

  it("rejects dangerous payload keys at the trust boundary", () => {
    for (const key of ["__proto__", "proto", "prototype", "constructor"]) {
      expect(validateEvent(event({ id: "x", type: "message.sent", payload: { [key]: "pwn" } }))).toMatch(
        /not allowed/
      );
    }
  });

  it("appended events cannot be mutated through caller-held references", () => {
    const owner = { sessionId: "s1", taskId: "t1" };
    const payload = { id: "attn-1" };
    const e = event({ id: "e1", type: "attention.created", owner, payload });
    const out = appendEvent(createEventLog(), e);
    expect(typeof out).not.toBe("string");
    const log = out as ReturnType<typeof createEventLog>;
    owner.sessionId = "MUTATED";
    payload.id = "MUTATED";
    e.owner.taskId = "MUTATED";
    e.payload.id = "MUTATED";
    expect(log.events[0].owner).toEqual({ sessionId: "s1", taskId: "t1" });
    expect(log.events[0].payload).toEqual({ id: "attn-1" });
  });

  it("filters by type and owner", () => {
    let log = createEventLog();
    const events = [
      event({ id: "a", type: "tool.started", ts: 1, owner: { sessionId: "s1" }, payload: { toolCallId: "c1" } }),
      event({ id: "b", type: "tool.completed", ts: 2, owner: { sessionId: "s1" }, payload: { toolCallId: "c1" } }),
      event({ id: "c", type: "attention.created", ts: 3, owner: { sessionId: "s2" }, payload: { id: "attn-2" } }),
    ];
    for (const e of events) {
      const out = appendEvent(log, e);
      log = out as ReturnType<typeof createEventLog>;
    }
    expect(listEvents(log, { types: ["tool.started"] }).map((e) => e.id)).toEqual(["a"]);
    expect(listEvents(log, { owner: { sessionId: "s2" } }).map((e) => e.id)).toEqual(["c"]);
  });

  it("mints unique event ids", () => {
    expect(newEventId()).not.toBe(newEventId());
  });
});

describe("createBabylonEvent", () => {
  it("produces valid events with minted ids, normalized owners, and copied payloads", () => {
    const payload = { id: "plan-9" };
    const owner = { sessionId: "  s1  ", taskId: "", agentId: undefined };
    const e = createBabylonEvent("plan.approved", { owner, payload, ts: 123 });
    expect(e.type).toBe("plan.approved");
    expect(e.ts).toBe(123);
    expect(e.id).toBeTruthy();
    // Blank/whitespace owner values are dropped, kept values are preserved.
    expect(e.owner).toEqual({ sessionId: "  s1  " });
    // The payload is a copy, not the caller's object.
    expect(e.payload).toEqual({ id: "plan-9" });
    expect(e.payload).not.toBe(payload);
    expect(validateEvent(e)).toBeNull();
  });

  it("defaults ts to now and works without owner or payload", () => {
    const before = Date.now();
    const e = createBabylonEvent("message.sent", {});
    expect(e.ts).toBeGreaterThanOrEqual(before);
    expect(e.owner).toEqual({});
    expect(e.payload).toEqual({});
    expect(validateEvent(e)).toBeNull();
  });

  it("mints distinct ids for each constructed event", () => {
    expect(createBabylonEvent("message.sent", {}).id).not.toBe(createBabylonEvent("message.sent", {}).id);
  });
});

describe("event projection", () => {
  function stream(): BabylonEvent[] {
    return [
      event({ id: "1", type: "task.blocked", ts: 10, owner: { taskId: "t1", projectId: "p1" }, payload: { reason: "policy" } }),
      event({ id: "2", type: "task.completed", ts: 20, owner: { taskId: "t1", projectId: "p1" } }),
      event({ id: "3", type: "attention.created", ts: 15, owner: {}, payload: { id: "attn-1" } }),
      event({ id: "4", type: "attention.resolved", ts: 30, owner: {}, payload: { id: "attn-1" } }),
      event({ id: "5", type: "process.started", ts: 5, owner: { processId: "proc-1" } }),
      event({ id: "6", type: "process.exited", ts: 25, owner: { processId: "proc-1" }, payload: { exitCode: 0 } }),
      event({ id: "7", type: "plan.proposed", ts: 8, owner: {}, payload: { id: "plan-1" } }),
      event({ id: "8", type: "plan.approved", ts: 9, owner: {}, payload: { id: "plan-1" } }),
      event({ id: "9", type: "message.sent", ts: 12, owner: { sessionId: "s1" } }),
    ];
  }

  it("rebuilds a deterministic view purely from events", () => {
    const a = projectEvents(stream());
    const b = projectEvents([...stream()].reverse());
    expect(a).toEqual(b);
    expect(a.tasks.t1).toEqual({ blockedAt: 10, completedAt: 20, lastActivityAt: 20 });
    expect(a.attention["attn-1"]).toEqual({ createdAt: 15, resolvedAt: 30 });
    expect(a.processes["proc-1"]).toEqual({ startedAt: 5, exitedAt: 25, exitPayload: { exitCode: 0 } });
    expect(a.plans["plan-1"]).toEqual({ proposedAt: 8, approvedAt: 9 });
    expect(a.counts["task.blocked"]).toBe(1);
    expect(a.firstTs).toBe(5);
    expect(a.lastTs).toBe(30);
  });

  it("reports ownership coverage per key", () => {
    const coverage = ownershipCoverage(stream());
    expect(coverage.taskId).toBe(2);
    expect(coverage.projectId).toBe(2);
    expect(coverage.processId).toBe(2);
    expect(coverage.sessionId).toBe(1);
    expect(coverage.worktreeId).toBe(0);
  });

  it("resolves attention subjects by payload id even when the owner carries a sessionId", () => {
    const projection = projectEvents([
      event({ id: "1", type: "attention.created", ts: 10, owner: { sessionId: "session-9" }, payload: { id: "attn-7" } }),
      event({ id: "2", type: "attention.resolved", ts: 20, owner: { sessionId: "session-9" }, payload: { id: "attn-7" } }),
    ]);
    expect(Object.keys(projection.attention)).toEqual(["attn-7"]);
    expect(projection.attention["attn-7"]).toEqual({ createdAt: 10, resolvedAt: 20 });
  });

  it("resolves plan subjects by payload id even when the owner carries task/session ids", () => {
    const projection = projectEvents([
      event({ id: "1", type: "plan.proposed", ts: 10, owner: { taskId: "task-1", sessionId: "session-9" }, payload: { id: "plan-3" } }),
      event({ id: "2", type: "plan.approved", ts: 20, owner: { taskId: "task-1", sessionId: "session-9" }, payload: { id: "plan-3" } }),
    ]);
    expect(Object.keys(projection.plans)).toEqual(["plan-3"]);
    expect(projection.plans["plan-3"]).toEqual({ proposedAt: 10, approvedAt: 20 });
  });

  it("resolves process subjects by owner.processId over any payload id", () => {
    const projection = projectEvents([
      event({ id: "1", type: "process.started", ts: 10, owner: { processId: "proc-real" }, payload: { id: "decoy" } }),
      event({ id: "2", type: "process.exited", ts: 20, owner: { processId: "proc-real" }, payload: { id: "decoy", exitCode: 1 } }),
    ]);
    expect(Object.keys(projection.processes)).toEqual(["proc-real"]);
    expect(projection.processes["proc-real"]?.exitedAt).toBe(20);
  });

  it("resolves task subjects by owner.taskId over any payload id", () => {
    const projection = projectEvents([
      event({ id: "1", type: "task.blocked", ts: 10, owner: { taskId: "task-real" }, payload: { id: "decoy", reason: "policy" } }),
      event({ id: "2", type: "task.completed", ts: 20, owner: { taskId: "task-real" }, payload: { id: "decoy" } }),
    ]);
    expect(Object.keys(projection.tasks)).toEqual(["task-real"]);
    expect(projection.tasks["task-real"]).toEqual({ blockedAt: 10, completedAt: 20, lastActivityAt: 20 });
  });
});
