// Babylon daemon host for Phase 6 (Control Plane, Feature 13).
//
// The runtime is extracted so the desktop and a future Babylon daemon talk over
// a typed protocol. This module is the daemon's brain: it owns the RuntimeState
// and applies protocol request envelopes to it, returning an updated runtime
// and a response envelope. It is pure and testable; the actual process, socket
// transport, and reconnection build on top of this.
//
// Supported requests: ping, task.created/updated/removed, attention.raised/
// resolved. Anything else returns an explicit "unsupported" response so the
// contract is honest rather than silently dropping frames.

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
  events: ProtocolEnvelope[];
}

export function createDaemonRuntime(): RuntimeState {
  return createRuntime();
}

function errorResponse(request: ProtocolEnvelope | null, message: string): ProtocolEnvelope {
  return createEnvelope("response", "pong", { error: message }, request?.id);
}

export function dispatchRequest(runtime: RuntimeState, request: ProtocolEnvelope): DispatchResult {
  const events: ProtocolEnvelope[] = [];
  let next = runtime;
  let response: ProtocolEnvelope;

  switch (request.type) {
    case "ping":
      response = createEnvelope("response", "pong", { ok: true }, request.id);
      break;

    case "task.created": {
      const task = request.payload as Task;
      if (!task || typeof task.id !== "string") {
        response = errorResponse(request, "task.created requires a task with an id");
        break;
      }
      next = { ...next, tasks: addTask(next.tasks, task) };
      response = createEnvelope("response", "task.created", task, request.id);
      break;
    }

    case "task.updated": {
      const { id, patch } = (request.payload ?? {}) as { id?: string; patch?: Partial<Task> };
      if (!id || !patch) {
        response = errorResponse(request, "task.updated requires { id, patch }");
        break;
      }
      next = { ...next, tasks: updateTask(next.tasks, id, patch) };
      response = createEnvelope("response", "task.updated", next.tasks.tasks[id] ?? null, request.id);
      break;
    }

    case "task.removed": {
      const { id } = (request.payload ?? {}) as { id?: string };
      if (!id) {
        response = errorResponse(request, "task.removed requires { id }");
        break;
      }
      next = { ...next, tasks: removeTask(next.tasks, id) };
      response = createEnvelope("response", "task.removed", { id, ok: true }, request.id);
      break;
    }

    case "attention.raised": {
      const item = request.payload as AttentionItem;
      if (!item || typeof item.id !== "string") {
        response = errorResponse(request, "attention.raised requires an item with an id");
        break;
      }
      next = { ...next, attention: addAttention(next.attention, item) };
      response = createEnvelope("response", "attention.raised", item, request.id);
      break;
    }

    case "attention.resolved": {
      const { id } = (request.payload ?? {}) as { id?: string };
      if (!id) {
        response = errorResponse(request, "attention.resolved requires { id }");
        break;
      }
      next = { ...next, attention: resolveAttention(next.attention, id) };
      response = createEnvelope("response", "attention.resolved", { id, ok: true }, request.id);
      break;
    }

    default:
      response = errorResponse(request, `unsupported request type ${String(request.type)}`);
  }

  return { runtime: next, response, events };
}

/**
 * Transport-boundary entry point: parse a JSON frame, dispatch it, and return
 * the updated runtime plus the serialized response. Malformed frames yield an
 * error response without touching the runtime.
 */
export function processFrame(runtime: RuntimeState, json: string): { runtime: RuntimeState; responseJson: string } {
  let request: ProtocolEnvelope | null = null;
  try {
    request = parseEnvelope(json);
  } catch (err) {
    return {
      runtime,
      responseJson: serializeError(request, err instanceof Error ? err.message : String(err)),
    };
  }
  const result = dispatchRequest(runtime, request);
  return { runtime: result.runtime, responseJson: JSON.stringify(result.response) };
}

function serializeError(request: ProtocolEnvelope | null, message: string): string {
  return JSON.stringify(errorResponse(request, message));
}
