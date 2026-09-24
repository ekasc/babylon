import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import type { AgentAction, PermissionEngine, Risk } from "./permissions";
import { isApprovalChoice, isExecutionMode, isPermissionMatch, isPolicyCategory } from "./permissions";
import type { DaemonClient } from "../src/daemon-client";
import { wireOf, wireStr } from "../src/store";

type PendingApproval = {
  action: AgentAction;
  risk: Risk;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string | null;
};

type Handle = IpcHandle;

export function registerPermissionsIpc(
  handle: Handle,
  deps: {
    getPermissionEngine: () => PermissionEngine | null;
    pendingApprovals: Map<string, PendingApproval>;
    notifyPermissionsChanged: () => void;
    resolveApproval: (id: string, choice: "allow_once" | "allow_session" | "allow_always" | "deny") => void;
    isDaemonOwned: () => boolean;
    requireDaemonClient: () => DaemonClient;
    getWindow: () => BrowserWindow | null;
  },
): void {
  const {
    getPermissionEngine,
    pendingApprovals,
    notifyPermissionsChanged,
    resolveApproval,
    isDaemonOwned,
    requireDaemonClient,
    getWindow,
  } = deps;
  // ---------------------------------------------------------------------------
  // Permission system (Phase 1): modes, rules, and approval resolution.
  // ---------------------------------------------------------------------------

  handle("pideck:permissions:get", async () => {
    if (isDaemonOwned()) {
      // The daemon is the authority for policy when it owns the runtime.
      // Return its current state directly. A disconnected daemon
      // surfaces as a thrown error (the UI shows a reconnecting
      // indicator) rather than a fabricated `auto` default that would
      // silently downgrade the agent's effective permissions.
      const client = requireDaemonClient();
      const res = await client.request("permissions.get", {});
      return res.payload;
    }
    const engine = getPermissionEngine();
    if (!engine) return { mode: "auto" as const, rules: [] };
    return { mode: engine.getMode(), rules: engine.listRules() };
  });
  handle("pideck:permissions:set-mode", async (_e, mode: unknown) => {
    if (!isExecutionMode(mode)) {
      throw new Error("invalid execution mode");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("permissions.set-mode", { mode });
      return res.payload;
    }
    const engine = getPermissionEngine();
    if (!engine) throw new Error("permission engine not ready");
    // The handler already validated the literal, so the engine receives a
    // genuine ExecutionMode rather than an asserted string.
    await engine.setModeAndPersist(mode);
    // A mode change retroactively re-evaluates what the agent is blocked on:
    // under Full Access the pending approvals are no longer required, so
    // release them instead of leaving the agent waiting on stale gates.
    if (mode === "full_access") {
      for (const [id, pending] of pendingApprovals) {
        clearTimeout(pending.timer);
        pendingApprovals.delete(id);
        getWindow()?.webContents.send("pideck:approval-cleared", { id });
        pending.resolve(true);
      }
    }
    notifyPermissionsChanged();
    return { mode: engine.getMode() };
  });
  handle("pideck:permissions:add-rule", async (_e, input: unknown) => {
    const rule = wireOf(input);
    const category = wireStr(rule, "category");
    const decision = wireStr(rule, "decision");
    const scope = wireStr(rule, "scope");
    if (!category || !isPolicyCategory(category) || (decision !== "allow" && decision !== "deny")) {
      throw new Error("invalid rule");
    }
    if (scope !== "always" && scope !== "session") {
      throw new Error("invalid rule scope");
    }
    const match = rule?.match;
    if (match !== undefined && !isPermissionMatch(match)) {
      throw new Error("invalid rule match");
    }
    const note = wireStr(rule, "note");
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("permissions.add-rule", input as Record<string, unknown>);
      return res.payload;
    }
    const engine = getPermissionEngine();
    if (!engine) throw new Error("permission engine not ready");
    const created = engine.addRule({
      category,
      decision,
      scope,
      ...(match !== undefined ? { match } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    await engine.flush();
    notifyPermissionsChanged();
    return created;
  });
  handle("pideck:permissions:remove-rule", async (_e, id: string) => {
    if (typeof id !== "string" || id.length < 1 || id.length > 200) throw new Error("invalid rule id");
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("permissions.remove-rule", { id });
      return res.payload;
    }
    const engine = getPermissionEngine();
    if (!engine) throw new Error("permission engine not ready");
    const removed = engine.removeRule(id);
    await engine.flush();
    notifyPermissionsChanged();
    return { removed };
  });
  handle("pideck:permissions:resolve-approval", async (_e, payload: { id: string; choice: string }) => {
    if (!payload || typeof payload.id !== "string" || !isApprovalChoice(payload.choice)) {
      throw new Error("invalid approval resolution");
    }
    if (isDaemonOwned()) {
      // Approvals are owned by the daemon in daemon mode. A local resolution
      // here would return { ok: true } while the daemon never hears about
      // the choice; the agent would then wait on a gate that no one will
      // ever open. Refuse loudly when the socket is down rather than lie.
      const client = requireDaemonClient();
      await client.request("approval.resolved", { id: payload.id, choice: payload.choice });
      getWindow()?.webContents.send("pideck:approval-resolved", { id: payload.id, choice: payload.choice });
      return { ok: true };
    }
    resolveApproval(payload.id, payload.choice);
    return { ok: true };
  });
  // Pending permission approvals, for renderer recovery after reload: the
  // runtime still waits on these, but the reloaded renderer never saw the
  // original request events. Daemon-owned approvals live in the daemon.
  handle("pideck:approvals:pending", async () => {
    if (isDaemonOwned()) {
      // Daemon-owned approvals live in the daemon across renderer reloads.
      try {
        const client = requireDaemonClient();
        const res = await client.request("approval.list", {});
        const approvals = (res.payload as { approvals?: unknown } | null)?.approvals;
        return Array.isArray(approvals) ? approvals : [];
      } catch {
        return [];
      }
    }
    return [...pendingApprovals.entries()].map(([id, pending]) => ({
      id,
      action: pending.action,
      risk: pending.risk,
      sessionId: pending.sessionId,
    }));
  });
}
