import { useCallback, useEffect, useState } from "react";
import { bridge, type PermissionRule, type PolicyCategory } from "../bridge";
import { Select, SelectOption } from "./ui/Select";

const CATEGORIES: { id: PolicyCategory; label: string }[] = [
  { id: "file_read", label: "File read" },
  { id: "file_write_workspace", label: "File write · workspace" },
  { id: "file_write_outside", label: "File write · outside" },
  { id: "shell_command", label: "Shell" },
  { id: "shell_destructive", label: "Shell · destructive" },
  { id: "network_access", label: "Network" },
  { id: "git_commit", label: "Git · commit" },
  { id: "git_push", label: "Git · push" },
  { id: "package_install", label: "Package install" },
  { id: "process_spawn", label: "Process" },
  { id: "privileged", label: "Privileged" },
];

export default function PermissionRulesSection() {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [showAdd, setShowAdd] = useState(false);
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
    const matchObj = match.trim() ? (isPath ? { pathGlob: match.trim() } : { commandPattern: match.trim() }) : undefined;
    await bridge.permissionsAddRule({ category, decision, scope, match: matchObj }).catch(() => undefined);
    setMatch("");
    setShowAdd(false);
  };
  const removeRule = async (id: string) => {
    await bridge.permissionsRemoveRule(id).catch(() => undefined);
  };

  return (
    <div>
      <p className="text-[13px] leading-5 text-dim max-w-[640px]">Explicit rules override the execution mode shown next to the composer. Deny always wins. Scopes: <span className="text-fg">Always</span> persists, <span className="text-fg">Session</span> clears on restart.</p>

      {rules.length === 0 ? (
        <p className="mt-4 rounded-[var(--radius-sm)] border border-dashed border-line/60 bg-inset/20 px-3 py-3 text-[13px] text-dim">No explicit rules. Behaviour follows the execution mode.</p>
      ) : (
        <div className="mt-4 border-t border-line overflow-hidden">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center gap-3 px-2.5 py-2.5 text-[13px] border-b border-line last:border-0">
              <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium ${rule.decision === "allow" ? "bg-ok/10 text-ok" : "bg-err/10 text-err"}`}>{rule.decision === "allow" ? "Allow" : "Deny"}</span>
              <span className="text-fg font-[450]">{CATEGORIES.find((c) => c.id === rule.category)?.label ?? rule.category}</span>
              {rule.match?.commandPattern ? <span className="text-[11px] text-dim truncate max-w-[200px]">“{rule.match.commandPattern}”</span> : null}
              {rule.match?.pathGlob ? <span className="text-[11px] text-dim truncate max-w-[200px]">{rule.match.pathGlob}</span> : null}
              <span className={`ml-auto text-[11px] px-1.5 py-0.5 rounded-full border ${rule.scope === "always" ? "border-line bg-bg text-dim" : "border-warn/20 bg-warn/10 text-warn"}`}>{rule.scope}</span>
              <button onClick={() => void removeRule(rule.id)} className="ml-1 rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-dim hover:text-err hover:bg-err/10">Remove</button>
            </div>
          ))}
        </div>
      )}

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)} className="mt-3 rounded-[var(--radius-sm)] border border-line/60 px-3 py-1.5 text-[13px] text-fg hover:bg-inset">+ Add rule</button>
      ) : (
        <div className="mt-3 rounded-[var(--radius-sm)] border border-line/40 bg-inset/20 p-3">
          <div className="grid grid-cols-[1.4fr_0.9fr_0.9fr] gap-2">
            <Select value={category} onChange={(v) => setCategory(v as PolicyCategory)} triggerClassName="rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 py-2 text-[13px] outline-none">
              {CATEGORIES.map((c) => <SelectOption key={c.id} value={c.id} label={c.label} />)}
            </Select>
            <Select value={decision} onChange={(v) => setDecision(v as "allow" | "deny")} triggerClassName="rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 py-2 text-[13px] outline-none">
              <SelectOption value="allow" label="Allow" />
              <SelectOption value="deny" label="Deny" />
            </Select>
            <Select value={scope} onChange={(v) => setScope(v as "always" | "session")} triggerClassName="rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 py-2 text-[13px] outline-none">
              <SelectOption value="always" label="Always" />
              <SelectOption value="session" label="Session" />
            </Select>
          </div>
          <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder={category.startsWith("file_") ? "Path glob, e.g. **/secrets/** (optional)" : "Command substring, e.g. npm run (optional)"} className="mt-2 w-full rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 py-2 text-[13px] outline-none focus:border-accent placeholder:text-dim" />
          <div className="mt-2 flex gap-2">
            <button onClick={() => void addRule()} className="rounded-[var(--radius-sm)] bg-fg text-bg px-3 py-1.5 text-[13px] font-medium hover:opacity-90">Add</button>
            <button onClick={() => setShowAdd(false)} className="rounded-[var(--radius-sm)] border border-line px-3 py-1.5 text-[13px] hover:bg-bg">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
