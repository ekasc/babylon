import { describe, expect, it } from "vitest";
import {
  createDaemonRuntime,
  dispatchRequest,
  processFrame,
  type DispatchResult,
} from "./daemon-host";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "./daemon-protocol";
import { createTask } from "./tasks";
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
});
