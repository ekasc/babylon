import { describe, expect, it } from "vitest";
import {
  createDaemonRuntime,
  dispatchRequest,
  processFrame,
  type DispatchResult,
} from "./daemon-host";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "./daemon-protocol";
import { createTask } from "./tasks";
import { createContract } from "./completion-contracts";
import type { AttentionItem } from "./attention";
import type { RuntimeState } from "./runtime";

function request(type: string, payload: unknown) {
  return createEnvelope("request", type as never, payload);
}

describe("babylon daemon host", () => {
  it("responds to ping without changing runtime", () => {
    const rt = createDaemonRuntime();
    const req = request("ping", null);
    const res: DispatchResult = dispatchRequest(rt, req);
    expect(res.response.type).toBe("pong");
    expect(res.response.inReplyTo).toBe(req.id);
    expect(res.runtime).toBe(rt); // unchanged reference
  });

  it("adds a task on task.created", () => {
    const rt = createDaemonRuntime();
    const task = createTask({ id: "t1", title: "x" });
    const res = dispatchRequest(rt, request("task.created", task));
    expect(res.runtime.tasks.tasks.t1.title).toBe("x");
    expect(res.response.type).toBe("task.created");
  });

  it("patches a task on task.updated", () => {
    let rt = createDaemonRuntime();
    rt = dispatchRequest(rt, request("task.created", createTask({ id: "t1", title: "x" }))).runtime;
    const res = dispatchRequest(rt, request("task.updated", { id: "t1", patch: { title: "y" } }));
    expect(res.runtime.tasks.tasks.t1.title).toBe("y");
  });

  it("removes a task on task.removed", () => {
    let rt = createDaemonRuntime();
    rt = dispatchRequest(rt, request("task.created", createTask({ id: "t1", title: "x" }))).runtime;
    const res = dispatchRequest(rt, request("task.removed", { id: "t1" }));
    expect(res.runtime.tasks.tasks.t1).toBeUndefined();
  });

  it("raises and resolves attention", () => {
    let rt = createDaemonRuntime();
    const item: AttentionItem = {
      id: "a1",
      type: "permission",
      title: "Approval required",
      createdAt: 1,
      resolved: false,
    };
    rt = dispatchRequest(rt, request("attention.raised", item)).runtime;
    expect(rt.attention.items.a1.resolved).toBe(false);
    rt = dispatchRequest(rt, request("attention.resolved", { id: "a1" })).runtime;
    expect(rt.attention.items.a1.resolved).toBe(true);
  });

  it("returns an explicit error response for unsupported types", () => {
    const rt = createDaemonRuntime();
    const res = dispatchRequest(rt, request("session.created", {}));
    expect(res.response.payload).toHaveProperty("error");
    expect(res.runtime).toBe(rt);
  });

  it("rejects malformed task payloads with an error", () => {
    const rt = createDaemonRuntime();
    const res = dispatchRequest(rt, request("task.created", { title: "no id" })); // missing id
    expect(res.response.payload).toHaveProperty("error");
    expect(res.runtime).toBe(rt);
  });

  it("processFrame round-trips a task.created over JSON", () => {
    const rt = createDaemonRuntime();
    const frame = serializeEnvelope(request("task.created", createTask({ id: "t1", title: "x" })));
    const out = processFrame(rt, frame);
    const response = parseEnvelope(out.responseJson);
    expect(response.type).toBe("task.created");
    expect(out.runtime.tasks.tasks.t1.title).toBe("x");
  });

  it("processFrame returns an error for malformed JSON without mutating", () => {
    const rt = createDaemonRuntime();
    const out = processFrame(rt, "{not json");
    const response = parseEnvelope(out.responseJson);
    expect(response.payload).toHaveProperty("error");
    expect(out.runtime).toBe(rt);
  });

  it("does not crash on task.updated for a missing id", () => {
    const rt = createDaemonRuntime();
    const res = dispatchRequest(rt, request("task.updated", { id: "nope", patch: { title: "y" } }));
    expect(res.response.type).toBe("error");
    expect(res.response.inReplyTo).toBeDefined();
    expect(res.runtime).toBe(rt);
    const out = processFrame(rt, serializeEnvelope(request("task.updated", { id: "nope", patch: { title: "y" } })));
    expect(parseEnvelope(out.responseJson).type).toBe("error");
    expect(out.runtime).toBe(rt);
  });

  it("rejects a non-object patch for task.updated", () => {
    const rt = createDaemonRuntime();
    const withTask = dispatchRequest(rt, request("task.created", createTask({ id: "t1", title: "x" }))).runtime;
    const res = dispatchRequest(withTask, request("task.updated", { id: "t1", patch: "bad" }));
    expect(res.response.type).toBe("error");
    expect(res.runtime).toBe(withTask);
  });

  it("returns an error and keeps the same runtime on duplicate task.created", () => {
    const rt = createDaemonRuntime();
    const task = createTask({ id: "t1", title: "x" });
    const once = dispatchRequest(rt, request("task.created", task)).runtime;
    const twice = dispatchRequest(once, request("task.created", createTask({ id: "t1", title: "y" })));
    expect(twice.response.type).toBe("error");
    expect(twice.runtime).toBe(once);
    expect(twice.runtime.tasks.tasks.t1.title).toBe("x");
  });

  it("returns an error on duplicate attention.raised and preserves the first item", () => {
    let rt = createDaemonRuntime();
    const item: AttentionItem = { id: "a1", type: "permission", title: "first", createdAt: 1, resolved: false };
    rt = dispatchRequest(rt, request("attention.raised", item)).runtime;
    const again = dispatchRequest(rt, request("attention.raised", { ...item, title: "second" }));
    expect(again.response.type).toBe("error");
    expect(again.runtime).toBe(rt);
    expect(again.runtime.attention.items.a1.title).toBe("first");
  });

  it("leaves runtime unchanged and signals removed false for a missing task.removed", () => {
    const rt = createDaemonRuntime();
    const res = dispatchRequest(rt, request("task.removed", { id: "nope" }));
    expect(res.runtime).toBe(rt);
    expect(res.response.payload).toMatchObject({ id: "nope", removed: false });
  });

  it("leaves runtime unchanged and signals resolved false for a missing attention.resolved", () => {
    const rt = createDaemonRuntime();
    const res = dispatchRequest(rt, request("attention.resolved", { id: "nope" }));
    expect(res.runtime).toBe(rt);
    expect(res.response.payload).toMatchObject({ id: "nope", resolved: false });
  });

  it("uses error type for failures so pong stays reserved for ping", () => {
    const rt = createDaemonRuntime();
    const dup = dispatchRequest(
      dispatchRequest(rt, request("task.created", createTask({ id: "t1", title: "x" }))).runtime,
      request("task.created", createTask({ id: "t1", title: "y" })),
    );
    expect(dup.response.type).toBe("error");
    const ping = dispatchRequest(rt, request("ping", null));
    expect(ping.response.type).toBe("pong");
  });

  it("registers a contract on contract.registered", () => {
    const rt = createDaemonRuntime();
    const contract = createContract({ id: "c1", title: "Ship it", checks: [{ kind: "tests", label: "tests pass", required: true }] });
    const res = dispatchRequest(rt, request("contract.registered", contract));
    expect(res.response.type).toBe("contract.registered");
    expect(res.runtime.contracts.c1).toEqual(contract);
  });

  it("replaces a known contract id on re-registration", () => {
    let rt = createDaemonRuntime();
    const first = createContract({ id: "c1", title: "Ship it", checks: [{ kind: "tests", label: "tests pass", required: true }] });
    rt = dispatchRequest(rt, request("contract.registered", first)).runtime;
    const second = createContract({ id: "c1", title: "Ship it harder", checks: [{ kind: "lint", label: "lint clean", required: true }] });
    const res = dispatchRequest(rt, request("contract.registered", second));
    expect(res.response.type).toBe("contract.registered");
    expect(res.runtime.contracts.c1.title).toBe("Ship it harder");
  });

  it("rejects malformed contract.registered payloads", () => {
    const rt = createDaemonRuntime();
    for (const payload of [{ id: "c1", title: "no checks" }, { id: "c1", checks: [] }, { title: "no id", checks: [] }, { id: "c1", title: 5, checks: [] }]) {
      const res = dispatchRequest(rt, request("contract.registered", payload));
      expect(res.response.type).toBe("error");
      expect(res.runtime).toBe(rt);
    }
  });

  it("serves contract.get and contract.list", () => {
    let rt = createDaemonRuntime();
    const a = createContract({ id: "c1", title: "A", checks: [] });
    const b = createContract({ id: "c2", title: "B", checks: [] });
    rt = dispatchRequest(rt, request("contract.registered", a)).runtime;
    rt = dispatchRequest(rt, request("contract.registered", b)).runtime;
    expect(dispatchRequest(rt, request("contract.get", { id: "c1" })).response.payload).toEqual({ contract: a });
    expect(dispatchRequest(rt, request("contract.get", { id: "nope" })).response.payload).toEqual({ contract: null });
    expect(dispatchRequest(rt, request("contract.list", {})).response.payload).toEqual({ contracts: [a, b] });
    expect(dispatchRequest(rt, request("contract.get", {})).response.type).toBe("error");
  });

  it("task.complete without a contract marks the task completed", () => {
    let rt = createDaemonRuntime();
    rt = dispatchRequest(rt, request("task.created", createTask({ id: "t1", title: "x" }))).runtime;
    const res = dispatchRequest(rt, request("task.complete", { id: "t1", results: [] }));
    expect(res.response.type).toBe("task.complete");
    expect(res.response.payload).toMatchObject({ blocked: false });
    expect(res.runtime.tasks.tasks.t1.status).toBe("completed");
  });

  it("task.complete passes when the contract checks pass", () => {
    let rt = createDaemonRuntime();
    const contract = createContract({ id: "c1", title: "Ship it", checks: [{ kind: "tests", label: "tests pass", required: true }] });
    rt = dispatchRequest(rt, request("contract.registered", contract)).runtime;
    rt = dispatchRequest(
      rt,
      request("task.created", { ...createTask({ id: "t1", title: "x" }), contractId: "c1" }),
    ).runtime;
    const res = dispatchRequest(rt, request("task.complete", { id: "t1", results: [{ kind: "tests", passed: true }] }));
    expect(res.response.payload).toMatchObject({ blocked: false });
    const evaluation = (res.response.payload as { evaluation?: { passed: boolean } }).evaluation;
    expect(evaluation?.passed).toBe(true);
    expect(res.runtime.tasks.tasks.t1.status).toBe("completed");
    expect(res.runtime.attention.items).toEqual({});
  });

  it("task.complete blocks on a failing contract, raising failed_task attention", () => {
    let rt = createDaemonRuntime();
    const contract = createContract({ id: "c1", title: "Ship it", checks: [{ kind: "tests", label: "tests pass", required: true }] });
    rt = dispatchRequest(rt, request("contract.registered", contract)).runtime;
    rt = dispatchRequest(
      rt,
      request("task.created", { ...createTask({ id: "t1", title: "x" }), contractId: "c1" }),
    ).runtime;
    const res = dispatchRequest(rt, request("task.complete", { id: "t1", results: [{ kind: "tests", passed: false }] }));
    expect(res.response.payload).toMatchObject({ blocked: true, reason: "contract failed: tests pass" });
    expect(res.runtime.tasks.tasks.t1.status).not.toBe("completed");
    const item = Object.values(res.runtime.attention.items)[0];
    expect(item).toMatchObject({ type: "failed_task", title: "Completion blocked: Ship it", source: "t1", resolved: false });
    expect((res.response.payload as { attention?: { id: string } }).attention?.id).toBe(item.id);
  });

  it("task.complete fails loudly when the contract is missing", () => {
    let rt = createDaemonRuntime();
    rt = dispatchRequest(
      rt,
      request("task.created", { ...createTask({ id: "t1", title: "x" }), contractId: "ghost" }),
    ).runtime;
    const res = dispatchRequest(rt, request("task.complete", { id: "t1", results: [] }));
    expect(res.response.type).toBe("error");
    expect(res.response.payload).toMatchObject({ error: "contract ghost not found for task t1" });
    expect(res.runtime).toBe(rt);
  });

  it("task.complete rejects unknown tasks and missing ids", () => {
    const rt = createDaemonRuntime();
    expect(dispatchRequest(rt, request("task.complete", { id: "nope", results: [] })).response.type).toBe("error");
    expect(dispatchRequest(rt, request("task.complete", { results: [] })).response.type).toBe("error");
    expect(rt.attention.items).toEqual({});
  });
});
