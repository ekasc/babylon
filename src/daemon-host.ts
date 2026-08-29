// Babylon daemon host for Phase 6 (Control Plane, Feature 13).
//
// The runtime is extracted so the desktop and a future Babylon daemon talk over
// a typed protocol. This module is the daemon's brain: it owns the RuntimeState
// and applies protocol request envelopes to it, returning an updated runtime
// and a response envelope. It is pure and testable; the actual process, socket
// transport, and reconnection build on top of this.
//
// Supported requests: ping, task.created/updated/removed/complete, contract.registered,
// attention.raised/resolved. Anything else returns an explicit error response so the
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
import {
  evaluateContract,
  type CheckResult,
  type CompletionContract,
} from "./completion-contracts";

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

    case "contract.get": {
      const { id } = (request.payload ?? {}) as { id?: string };
      if (!id) {
        response = errorResponse(request, "contract.get requires { id }");
        break;
      }
      response = createEnvelope("response", "contract.get", { contract: next.contracts[id] ?? null }, request.id);
      break;
    }

    case "contract.list": {
      response = createEnvelope("response", "contract.list", { contracts: Object.values(next.contracts) }, request.id);
      break;
    }

    case "contract.registered": {
      const contract = request.payload as CompletionContract;
      if (
        !isPlainObject(contract) ||
        typeof contract.id !== "string" ||
        typeof contract.title !== "string" ||
        !Array.isArray(contract.checks)
      ) {
        response = errorResponse(request, "contract.registered requires a contract object with id, title, and checks");
        break;
      }
      // Later registrations replace the definition (matching the desktop's
      // previous set-by-id semantics) so re-setting a persisted contract is
      // harmless rather than a duplicate error.
      next = { ...next, contracts: { ...next.contracts, [contract.id]: contract } };
      response = createEnvelope("response", "contract.registered", contract, request.id);
      break;
    }

    case "task.complete": {
      const body = (request.payload ?? {}) as { id?: string; results?: unknown };
      const { id } = body;
      if (!id) {
        response = errorResponse(request, "task.complete requires { id }");
        break;
      }
      const task = next.tasks.tasks[id];
      if (!task) {
        response = errorResponse(request, `task ${id} not found`);
        break;
      }
      const contract = task.contractId ? next.contracts[task.contractId] : undefined;
      if (task.contractId && !contract) {
        // A task referencing a contract the runtime no longer has must fail
        // loudly: silently completing would drop the gate entirely.
        response = errorResponse(request, `contract ${task.contractId} not found for task ${id}`);
        break;
      }
      const checkResults = Array.isArray(body.results) ? (body.results as CheckResult[]) : [];
      if (contract) {
        const evaluation = evaluateContract(contract, checkResults);
        if (!evaluation.passed) {
          const failed = evaluation.checks
            .filter((c) => c.check.required && !c.satisfied)
            .map((c) => c.check.label);
          const item: AttentionItem = {
            id: `contract-${id}-${Date.now()}`,
            type: "failed_task",
            title: `Completion blocked: ${contract.title}`,
            detail: failed.length ? `contract failed: ${failed.join(", ")}` : "contract failed",
            source: id,
            createdAt: Date.now(),
            resolved: false,
          };
          commitAttention(addAttention(next.attention, item));
          response = createEnvelope(
            "response",
            "task.complete",
            {
              blocked: true,
              reason: failed.length ? `contract failed: ${failed.join(", ")}` : "contract failed",
              evaluation,
              attention: item,
            },
            request.id,
          );
          break;
        }
        commitTasks(updateTask(next.tasks, id, { status: "completed" }));
        response = createEnvelope("response", "task.complete", { blocked: false, evaluation }, request.id);
        break;
      }
      commitTasks(updateTask(next.tasks, id, { status: "completed" }));
      response = createEnvelope("response", "task.complete", { blocked: false }, request.id);
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
