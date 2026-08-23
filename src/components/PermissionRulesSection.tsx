import { useCallback, useEffect, useState } from "react";
import { bridge, type PermissionRule, type PolicyCategory } from "../bridge";

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

/**
 * Permission rules management for the Settings page. The live execution mode
 * lives next to the composer (PermissionModePicker); this surface is for the
 * slower-moving configuration: persistent and session allow/deny rules.
 */
export default function PermissionRulesSection() {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [category, setCategory] = useState<PolicyCategory>("shell_command");
  const [decision, setDecision] = useState<"allow" | "deny">("allow");
  const [scope, setScope] = useState<"always" | "session">("always");
  const [match, setMatch] = useState("");

  const refresh = useCallback(() => {
    bridge.permissionsGet().then((s) => setRules(s.rules)).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    return bridge.onPermissionsChanged((next) => setRules(next.rules));
  }, [refresh]);

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
    <>
      <p className="settings-section-hint">
        Explicit rules override the execution mode (shown next to the composer). Deny always wins.
      </p>

      {rules.length === 0 ? (
        <p className="text-[12.5px] text-dim">No explicit rules. Behaviour follows the execution mode.</p>
      ) : (
        <ul className="space-y-1.5">
          {rules.map((rule) => (
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
                onClick={() => void removeRule(rule.id)}
                className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11.5px] hover:border-err hover:text-err"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 border-t border-line pt-4">
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
          onClick={() => void addRule()}
          className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90"
        >
          Add rule
        </button>
      </div>
    </>
  );
}
