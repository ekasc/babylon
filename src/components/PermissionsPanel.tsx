import { useCallback, useEffect, useState } from "react";
import { bridge, type PermissionMode, type PermissionRule, type PermissionState, type PolicyCategory } from "../bridge";

const CATEGORIES: PolicyCategory[] = [
  "file_read",
  "file_write_workspace",
  "file_write_outside",
  "shell_command",
  "shell_destructive",
  "network_access",
  "git_commit",
  "git_push",
  "package_install",
  "process_spawn",
  "privileged",
];

const MODE_META: Record<PermissionMode, { label: string; hint: string; danger?: boolean }> = {
  supervised: {
    label: "Supervised",
    hint: "Ask before every consequential action — writes, external access, shell, git push.",
  },
  auto: {
    label: "Auto",
    hint: "Routine actions run; high or uncertain risk is approved interactively.",
  },
  full_access: {
    label: "Full Access",
    hint: "Run without approval prompts. Explicit deny rules still block.",
    danger: true,
  },
};

/**
 * Permission settings surface: the active execution mode, the persistent and
 * session rules, and a small composer for adding a rule. Rules live outside Pi
 * session files (main process), so this is always the source of truth.
 */
export function PermissionsPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<PermissionState>({ mode: "auto", rules: [] });
  const [category, setCategory] = useState<PolicyCategory>("shell_command");
  const [decision, setDecision] = useState<"allow" | "deny">("allow");
  const [scope, setScope] = useState<"always" | "session">("always");
  const [match, setMatch] = useState("");

  const refresh = useCallback(() => {
    bridge.permissionsGet().then(setState).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    return bridge.onPermissionsChanged((next) => setState(next));
  }, [refresh]);

  const setMode = async (mode: PermissionMode) => {
    await bridge.permissionsSetMode(mode).catch(() => undefined);
  };

  const addRule = async () => {
    const isPath = category.startsWith("file_");
    const matchObj = match.trim()
      ? isPath
        ? { pathGlob: match.trim() }
        : { commandPattern: match.trim() }
      : undefined;
    await bridge
      .permissionsAddRule({ category, decision, scope, match: matchObj })
      .catch(() => undefined);
    setMatch("");
  };

  const removeRule = async (id: string) => {
    await bridge.permissionsRemoveRule(id).catch(() => undefined);
  };

  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onMouseDown={onClose}>
      <div className="modal-surface w-full max-w-lg p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold tracking-tight">Agent permissions</h3>
          <button onClick={onClose} className="rounded-lg border border-line px-2 py-1 text-[12.5px] hover:border-accent">
            Close
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {(Object.keys(MODE_META) as PermissionMode[]).map((m) => {
            const meta = MODE_META[m];
            const active = state.mode === m;
            const cls = meta.danger
              ? active
                ? "border-warn bg-warn/15 text-warn"
                : "border-line text-dim hover:border-warn"
              : active
                ? "border-accent bg-accent/10 text-accent"
                : "border-line text-dim hover:border-accent";
            return (
              <button key={m} onClick={() => setMode(m)} className={`rounded-lg border px-2 py-2 text-[12.5px] font-semibold ${cls}`}>
                {meta.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] text-dim">{MODE_META[state.mode].hint}</p>

        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Rules</div>
          {state.rules.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-dim">No explicit rules. Behaviour follows the execution mode above.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {state.rules.map((rule: PermissionRule) => (
                <li key={rule.id} className="flex items-center gap-2 rounded-lg border border-line bg-bg/40 px-2.5 py-1.5 text-[12.5px]">
                  <span className={rule.decision === "allow" ? "text-ok" : "text-err"}>
                    {rule.decision === "allow" ? "Allow" : "Deny"}
                  </span>
                  <span className="text-fg/80">{rule.category.replace(/_/g, " ")}</span>
                  {rule.match?.commandPattern ? <span className="text-dim">· “{rule.match.commandPattern}”</span> : null}
                  {rule.match?.pathGlob ? <span className="text-dim">· {rule.match.pathGlob}</span> : null}
                  <span className={`pill ${rule.scope === "always" ? "bg-accent/10 text-accent" : "bg-raised text-dim"}`}>
                    {rule.scope}
                  </span>
                  <button
                    onClick={() => removeRule(rule.id)}
                    className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11.5px] hover:border-err hover:text-err"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Add rule</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as PolicyCategory)}
              className="rounded-lg border border-line bg-bg px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <select
                value={decision}
                onChange={(e) => setDecision(e.target.value as "allow" | "deny")}
                className="flex-1 rounded-lg border border-line bg-bg px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
              >
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "always" | "session")}
                className="flex-1 rounded-lg border border-line bg-bg px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
              >
                <option value="always">Always</option>
                <option value="session">Session</option>
              </select>
            </div>
          </div>
          <input
            value={match}
            onChange={(e) => setMatch(e.target.value)}
            placeholder={category.startsWith("file_") ? "Path glob, e.g. **/secrets/** (optional)" : "Command substring, e.g. npm run (optional)"}
            className="mt-2 w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
          />
          <button
            onClick={addRule}
            className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90"
          >
            Add rule
          </button>
        </div>
      </div>
    </div>
  );
}
