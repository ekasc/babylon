import { useCallback, useEffect, useState } from "react";
import { bridge, type PermissionRule, type PolicyCategory } from "../bridge";

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
      <p className="text-[12.5px] leading-5 text-dim max-w-[640px]">Explicit rules override the execution mode shown next to the composer. Deny always wins. Scopes: <span className="text-fg">Always</span> persists, <span className="text-fg">Session</span> clears on restart.</p>

      {rules.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-line/60 bg-inset/20 px-3 py-3 text-[12.5px] text-dim">No explicit rules. Behaviour follows the execution mode.</p>
      ) : (
        <div className="mt-4 border border-line/30 rounded-md overflow-hidden divide-y divide-line/20">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center gap-3 px-3 py-2.5 text-[12.5px]">
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${rule.decision === "allow" ? "bg-ok/10 text-ok" : "bg-err/10 text-err"}`}>{rule.decision === "allow" ? "Allow" : "Deny"}</span>
              <span className="text-fg font-[450]">{CATEGORIES.find((c) => c.id === rule.category)?.label ?? rule.category}</span>
              {rule.match?.commandPattern ? <span className="font-mono text-[11px] text-dim truncate max-w-[200px]">“{rule.match.commandPattern}”</span> : null}
              {rule.match?.pathGlob ? <span className="font-mono text-[11px] text-dim truncate max-w-[200px]">{rule.match.pathGlob}</span> : null}
              <span className={`ml-auto text-[11px] px-1.5 py-0.5 rounded border ${rule.scope === "always" ? "border-line bg-bg text-dim" : "border-amber-500/20 bg-amber-500/10 text-amber-700"}`}>{rule.scope}</span>
              <button onClick={() => void removeRule(rule.id)} className="ml-1 rounded px-2 py-1 text-[11px] text-dim hover:text-err hover:bg-err/10">Remove</button>
            </div>
          ))}
        </div>
      )}

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)} className="mt-3 rounded-md border border-line/60 px-3 py-1.5 text-[12.5px] text-fg hover:bg-inset">+ Add rule</button>
      ) : (
        <div className="mt-3 rounded-md border border-line/40 bg-inset/20 p-3">
          <div className="grid grid-cols-[1.4fr_0.9fr_0.9fr] gap-2">
            <select value={category} onChange={(e) => setCategory(e.target.value as PolicyCategory)} className="rounded-md border border-line bg-bg px-2.5 py-2 text-[12.5px] outline-none focus:border-accent">
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <select value={decision} onChange={(e) => setDecision(e.target.value as "allow" | "deny")} className="rounded-md border border-line bg-bg px-2.5 py-2 text-[12.5px] outline-none focus:border-accent">
              <option value="allow">Allow</option><option value="deny">Deny</option>
            </select>
            <select value={scope} onChange={(e) => setScope(e.target.value as "always" | "session")} className="rounded-md border border-line bg-bg px-2.5 py-2 text-[12.5px] outline-none focus:border-accent">
              <option value="always">Always</option><option value="session">Session</option>
            </select>
          </div>
          <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder={category.startsWith("file_") ? "Path glob, e.g. **/secrets/** (optional)" : "Command substring, e.g. npm run (optional)"} className="mt-2 w-full rounded-md border border-line bg-bg px-2.5 py-2 text-[12.5px] outline-none focus:border-accent placeholder:text-dim/60" />
          <div className="mt-2 flex gap-2">
            <button onClick={() => void addRule()} className="rounded-md bg-fg text-bg px-3 py-1.5 text-[12.5px] font-medium hover:opacity-90">Add</button>
            <button onClick={() => setShowAdd(false)} className="rounded-md border border-line px-3 py-1.5 text-[12.5px] hover:bg-bg">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
