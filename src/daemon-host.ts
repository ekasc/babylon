// Babylon daemon host for Phase 6 (Control Plane, Feature 13).
//
// The runtime is extracted so the desktop and a future Babylon daemon talk over
// a typed protocol. This module is the daemon's brain: it owns the RuntimeState
// and applies protocol request envelopes to it, returning an updated runtime
// and a response envelope. It is pure and testable; the actual process, socket
// transport, and reconnection build on top of this.
//
// Supported requests: ping, task.created/updated/removed, attention.raised/
// resolved. Anything else returns an explicit error response so the contract is
// honest rather than silently dropping frames.

import {
  createEnvelope,
  parseEnvelope,
  type ProtocolEnvelope,
} from "./daemon-protocol";
import { createRuntime, type RuntimeState } from "./runtime";
import { addAttention, resolveAttention, type AttentionItem } from "./attention";
import {
  addTask,
  removeTask,
  updateTask,
  type Task,
} from "./tasks";

export interface DispatchResult {
  runtime: RuntimeState;
  response: ProtocolEnvelope;
}

export function createDaemonRuntime(): RuntimeState {
  return createRuntime();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(request: ProtocolEnvelope | null, message: string): ProtocolEnvelope {
  return createEnvelope("response", "error", { error: message }, request?.id);
}

export function dispatchRequest(runtime: RuntimeState, request: ProtocolEnvelope): DispatchResult {
  let next = runtime;
  let response: ProtocolEnvelope;

  const commitTasks = (tasks = next.tasks) => {
    if (tasks !== next.tasks) next = { ...next, tasks };
  };
  const commitAttention = (attention = next.attention) => {
    if (attention !== next.attention) next = { ...next, attention };
  };

  switch (request.type) {
    case "ping":
      response = createEnvelope("response", "pong", { ok: true }, request.id);
      break;

    case "task.created": {
      const task = request.payload as Task;
      if (!isPlainObject(task) || typeof task.id !== "string") {
        response = errorResponse(request, "task.created requires a task object with an id");
        break;
      }
      const after = addTask(next.tasks, task);
      if (after === next.tasks) {
        response = errorResponse(request, `task ${task.id} already exists`);
        break;
      }
      commitTasks(after);
      response = createEnvelope("response", "task.created", task, request.id);
      break;
    }

    case "task.updated": {
      const body = request.payload as { id?: string; patch?: unknown };
      const { id, patch } = body;
      if (!id || !isPlainObject(patch)) {
        response = errorResponse(request, "task.updated requires { id, patch }");
        break;
      }
      const after = updateTask(next.tasks, id, patch as Partial<Task>);
      if (after === next.tasks) {
        response = errorResponse(request, `task ${id} not found`);
        break;
      }
      commitTasks(after);
      response = createEnvelope("response", "task.updated", after.tasks[id], request.id);
      break;
    }

    case "task.removed": {
      const { id } = (request.payload ?? {}) as { id?: string };
      if (!id) {
        response = errorResponse(request, "task.removed requires { id }");
        break;
      }
      const after = removeTask(next.tasks, id);
      const removed = after !== next.tasks;
      commitTasks(after);
      response = createEnvelope("response", "task.removed", { id, ok: true, removed }, request.id);
      break;
    }

    case "attention.raised": {
      const item = request.payload as AttentionItem;
      if (!isPlainObject(item) || typeof item.id !== "string") {
        response = errorResponse(request, "attention.raised requires an item object with an id");
        break;
      }
      const after = addAttention(next.attention, item);
      if (after === next.attention) {
        response = errorResponse(request, `attention item ${item.id} already exists`);
        break;
      }
      commitAttention(after);
      response = createEnvelope("response", "attention.raised", item, request.id);
      break;
    }

    case "attention.resolved": {
      const { id } = (request.payload ?? {}) as { id?: string };
      if (!id) {
        response = errorResponse(request, "attention.resolved requires { id }");
        break;
      }
      const after = resolveAttention(next.attention, id);
      const resolved = after !== next.attention;
      commitAttention(after);
      response = createEnvelope("response", "attention.resolved", { id, ok: true, resolved }, request.id);
      break;
    }

    default:
      response = errorResponse(request, `unsupported request type ${String(request.type)}`);
  }

  return { runtime: next, response };
}

/**
 * Transport-boundary entry point: parse a JSON frame, dispatch it, and return
 * the updated runtime plus the serialized response. Malformed frames (JSON or
 * envelope validation) and handler errors yield an error response without
 * touching the runtime.
 */
export function processFrame(runtime: RuntimeState, json: string): { runtime: RuntimeState; responseJson: string } {
  let request: ProtocolEnvelope | null = null;
  try {
    request = parseEnvelope(json);
  } catch (err) {
    return {
      runtime,
      responseJson: JSON.stringify(errorResponse(null, err instanceof Error ? err.message : String(err))),
    };
  }
  try {
    const result = dispatchRequest(runtime, request);
    return { runtime: result.runtime, responseJson: JSON.stringify(result.response) };
  } catch (err) {
    return {
      runtime,
      responseJson: JSON.stringify(errorResponse(request, err instanceof Error ? err.message : String(err))),
    };
  }
}
