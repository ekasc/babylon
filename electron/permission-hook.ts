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
import type { HookManager } from "./hook-manager";

export function installPermissionHook(
  agent: any,
  controller: BabylonPermissionController,
  cwd: string
): void {
  installAgentGuards(agent, { controller, cwd });
}

export function installAgentGuards(
  agent: any,
  opts: { controller: BabylonPermissionController; cwd: string; hookManager?: HookManager; sessionId?: string; taskId?: string }
): void {
  const originalBefore = agent.beforeToolCall?.bind(agent);
  agent.beforeToolCall = async (ctx: any, signal: any) => {
    const hookManager = opts.hookManager;
    if (hookManager) {
      const outcome = await hookManager.dispatch(
        "pre_tool_use",
        {
          toolName: ctx?.toolCall?.name ?? "",
          args: ctx?.args,
          sessionId: opts.sessionId ?? "",
          taskId: opts.taskId,
        },
        async (def, _hctx) => {
          if (def.action === "block") return { block: { reason: `Blocked by hook ${def.id}` } };
          if (def.action === "rewrite_args" && _hctx.args && typeof _hctx.args === "object") {
            return { rewriteArgs: { ...(_hctx.args as Record<string, unknown>), _hookRewrittenBy: def.id } };
          }
          return {};
        }
      );
      if (outcome.blocked) {
        return { block: true, reason: outcome.blocked.result.block?.reason ?? `Blocked by hook ${outcome.blocked.id}` };
      }
      if (outcome.rewrittenArgs !== undefined) {
        ctx = { ...ctx, args: outcome.rewrittenArgs };
      }
    }

    const action = mapToolToAction(ctx?.toolCall?.name ?? "", ctx?.args, opts.cwd);
    if (action) {
      const result = opts.controller.evaluate(action);
      if (result.decision === "deny") {
        return { block: true, reason: result.reason ?? "Blocked by Babylon permission policy" };
      }
      if (result.decision === "ask") {
        const allowed = await opts.controller.requestApproval(action, result.risk ?? "uncertain");
        if (!allowed) return { block: true, reason: "Denied by user approval" };
      }
    }
    return originalBefore ? originalBefore(ctx, signal) : undefined;
  };
}
