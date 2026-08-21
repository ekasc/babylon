import { describe, expect, it } from "vitest";
import { appendEvent, createEventLog, listEvents, newEventId, validateEvent, type BabylonEvent } from "./events";
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

  it("rejects malformed events with actionable reasons", () => {
    expect(validateEvent(null)).toMatch(/object/);
    expect(validateEvent({ id: "", type: "turn.started", ts: 1 })).toMatch(/non-empty id/);
    expect(validateEvent({ id: "x", type: "turn.exploded", ts: 1 })).toMatch(/unknown event type/);
    expect(validateEvent({ id: "x", type: "turn.started", ts: Number.NaN })).toMatch(/finite ts/);
    expect(validateEvent({ id: "x", type: "turn.started", ts: 1, payload: 5 })).toMatch(/payload/);
    expect(validateEvent({ id: "x", type: "turn.started", ts: 1, owner: { horseId: "h" } })).toMatch(/ownership key/);
    expect(validateEvent({ id: "x", type: "turn.started", ts: 1, owner: { taskId: "" } })).toMatch(/non-empty string/);
  });

  it("filters by type and owner", () => {
    let log = createEventLog();
    const events = [
      event({ id: "a", type: "tool.started", ts: 1, owner: { sessionId: "s1" } }),
      event({ id: "b", type: "tool.completed", ts: 2, owner: { sessionId: "s1" } }),
      event({ id: "c", type: "attention.created", ts: 3, owner: { sessionId: "s2" } }),
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

describe("event projection", () => {
  function stream(): BabylonEvent[] {
    return [
      event({ id: "1", type: "task.blocked", ts: 10, owner: { taskId: "t1", projectId: "p1" }, payload: { reasons: ["policy"] } }),
      event({ id: "2", type: "task.completed", ts: 20, owner: { taskId: "t1", projectId: "p1" } }),
      event({ id: "3", type: "attention.created", ts: 15, owner: {}, payload: { id: "attn-1" } }),
      event({ id: "4", type: "attention.resolved", ts: 30, owner: {}, payload: { id: "attn-1" } }),
      event({ id: "5", type: "process.started", ts: 5, owner: { processId: "proc-1" } }),
      event({ id: "6", type: "process.exited", ts: 25, owner: { processId: "proc-1" }, payload: { code: 0 } }),
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
    expect(a.processes["proc-1"]).toEqual({ startedAt: 5, exitedAt: 25, exitPayload: { code: 0 } });
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
});
