// Remote action authorization for Phase 7 (Remote Control, Feature 15).
//
// The remote surface is intentionally small: view tasks and agent state,
// receive attention notifications, approve/deny, answer questions, stop/pause/
// resume tasks, and view concise diffs. Each action maps to exactly one device
// scope from device-pairing.ts, and every remote request is checked against
// the paired device's grant before it touches anything.

import { isAuthorized, type DeviceRegistry, type DeviceScope } from "./device-pairing";

export type RemoteActionKind =
  | "remote.tasks.list"
  | "remote.state.view"
  | "remote.attention.resolve"
  | "remote.question.answer"
  | "remote.task.stop_resume"
  | "remote.diffs.view";

export const REMOTE_ACTION_KINDS: readonly RemoteActionKind[] = [
  "remote.tasks.list",
  "remote.state.view",
  "remote.attention.resolve",
  "remote.question.answer",
  "remote.task.stop_resume",
  "remote.diffs.view",
];

/** One action, one scope. A device either may do it or may not. */
export const ACTION_SCOPES: Record<RemoteActionKind, DeviceScope> = {
  "remote.tasks.list": "view_tasks",
  "remote.state.view": "view_state",
  "remote.attention.resolve": "approve_deny",
  "remote.question.answer": "answer_questions",
  "remote.task.stop_resume": "stop_resume",
  "remote.diffs.view": "view_diffs",
};

export type AuthorizationResult = { ok: true } | { ok: false; reason: string };

/**
 * Check that `deviceId` is a paired, non-revoked device whose grant includes
 * the scope `action` requires. Reasons are returned so a client UI can explain
 * a denial instead of showing a bare failure.
 */
export function authorizeAction(
  registry: DeviceRegistry,
  deviceId: string,
  action: RemoteActionKind
): AuthorizationResult {
  const device = registry.devices[deviceId];
  if (!device) return { ok: false, reason: `unknown device ${deviceId}` };
  if (device.revoked) return { ok: false, reason: `device ${deviceId} has been revoked` };
  const scope = ACTION_SCOPES[action];
  if (!isAuthorized(registry, deviceId, scope)) {
    return { ok: false, reason: `device ${deviceId} lacks the ${scope} scope required for ${action}` };
  }
  return { ok: true };
}
