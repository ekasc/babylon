// Shared installer for the Babylon permission hook on a Pi agent instance.
//
// Babylon gates every agent tool call via Pi's `beforeToolCall` hook. The main
// session installs it in pi-host.bindSession, but subagent and thread sessions
// are created elsewhere and would otherwise bypass the gate. This helper is the
// single place that wraps the SDK hook, so all session kinds enforce the same
// policy and preserve the SDK's original hook (extensions like managed-subagents
// keep working underneath).

import { mapToolToAction } from "./permission-agent";
import type { BabylonPermissionController } from "./permissions";

export function installPermissionHook(
  agent: any,
  controller: BabylonPermissionController,
  cwd: string
): void {
  const originalBefore = agent.beforeToolCall?.bind(agent);
  agent.beforeToolCall = async (ctx: any, signal: any) => {
    const action = mapToolToAction(ctx?.toolCall?.name ?? "", ctx?.args, cwd);
    if (action) {
      const result = controller.evaluate(action);
      if (result.decision === "deny") {
        return { block: true, reason: result.reason ?? "Blocked by Babylon permission policy" };
      }
      if (result.decision === "ask") {
        const allowed = await controller.requestApproval(action, result.risk ?? "uncertain");
        if (!allowed) return { block: true, reason: "Denied by user approval" };
      }
    }
    return originalBefore ? originalBefore(ctx, signal) : undefined;
  };
}
