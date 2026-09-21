import { useMemo, useState } from "react";
import type { AgentModel, AgentState, PiSettings } from "../../bridge";
import { SettingSection } from "./SettingSection";
import { filterModels, getProviders } from "../../lib/model-helpers";
import { Select, SelectOption } from "../ui/Select";
import { formatNumber } from "../../lib/format";
import { modelSupportsImages } from "../../../electron/snapcompact/model-profiles";

type Mode = "summary" | "automatic" | "snapcompact";

export function SettingsContext({
  models,
  agentState,
  settings,
  onSave,
}: {
  models: AgentModel[];
  agentState: AgentState | null;
  settings: PiSettings | null;
  onSave: (p: Partial<PiSettings>) => void;
}) {
  const mode: Mode = (settings?.compaction?.mode as Mode) ?? "summary";
  const [q, setQ] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const overrides = settings?.contextWindowOverrides ?? {};

  const currentModel = agentState?.model ?? null;
  const supportsVision = !!(
    modelSupportsImages(currentModel) ||
    currentModel?.supportsImages ||
    currentModel?.vision ||
    currentModel?.capabilities?.vision
  );

  const effective = (m: AgentModel) => {
    const key = `${m.provider}/${m.id}`;
    return overrides[key] ?? m.contextWindow;
  };

  const commit = (provider: string, modelId: string, raw: string) => {
    const key = `${provider}/${modelId}`;
    const next = { ...overrides };
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) delete next[key];
    else next[key] = Math.round(n);
    setDraft((d) => ({ ...d, [key]: raw }));
    onSave({ contextWindowOverrides: next });
  };

  const filtered = useMemo(() => filterModels(models, q, providerFilter), [models, q, providerFilter]);

  const providers = useMemo(() => getProviders(models), [models]);
  const modifiedCount = Object.keys(overrides).length;

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Context</h2>
      <p className="text-[13px] leading-5 text-dim mt-1">Compaction and context-window behaviour.</p>

      <SettingSection title="Compaction strategy">
        <div className="max-w-[560px] border-t border-line">
          {(["summary", "automatic", "snapcompact"] as Mode[]).map((m) => (
            <label key={m} className={`flex items-start gap-3 px-2.5 py-3 border-b border-line cursor-pointer ${mode === m ? "bg-inset/40" : "hover:bg-inset/40"}`}>
              <input type="radio" name="compaction" checked={mode === m} onChange={() => onSave({ compaction: { mode: m } })} className="mt-1 accent-accent" />
              <span className="flex-1">
                <span className="flex items-center gap-2 text-[14px] font-[550] tracking-[-0.01em]">
                  {m === "summary" ? "Summary" : m === "automatic" ? "Automatic" : "Snapcompact"}
                  {m === "snapcompact" ? <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-warn/10 text-warn">Experimental</span> : null}
                </span>
                <span className="block text-[13px] leading-5 text-dim">
                  {m === "summary" ? "Traditional text compaction." : m === "automatic" ? "Babylon chooses based on model capabilities." : "Bitmap-backed historical context for vision models."}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3 rounded-[var(--radius-sm)] border border-line/30 bg-inset/30 px-4 py-3 text-[13px] leading-6 max-w-[560px]">
          <div className="flex gap-2"><span className="text-dim">Current model</span><span>{currentModel ? `${currentModel.provider}/${currentModel.id}` : "(no active session)"}</span></div>
          <div className="flex gap-2"><span className="text-dim">Vision support</span><span>{currentModel ? (supportsVision ? "Yes" : "No") : "—"}</span></div>
          <div className="flex gap-2"><span className="text-dim">Effective strategy</span><span className="font-medium">{mode === "automatic" ? (supportsVision ? "Snapcompact" : "Summary") : mode === "snapcompact" && !supportsVision ? "Summary (fallback)" : mode}</span></div>
          {mode === "snapcompact" && !supportsVision && currentModel ? <p className="mt-1 text-dim">Current model does not support images. Snapcompact will fall back safely.</p> : null}
        </div>
      </SettingSection>

      <SettingSection title="Context window overrides" hint="Expert overrides per model. Incorrect values can cause premature compaction or provider request failures.">
        <div className="flex gap-2 mb-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models…" className="settings-input flex-1" />
          <Select value={providerFilter} onChange={setProviderFilter} triggerClassName="settings-input w-[160px]">
            <SelectOption value="all" label="All providers" />
            {providers.map((p) => <SelectOption key={p} value={p}>{p}</SelectOption>)}
          </Select>
          {modifiedCount ? <button onClick={() => onSave({ contextWindowOverrides: {} })} className="rounded-[var(--radius-sm)] border border-line px-3 text-[12px] hover:border-err hover:text-err">Reset all</button> : null}
        </div>
        {!models.length ? <p className="text-[12px] text-dim">No models available.</p> : (
          <div className="max-h-[480px] overflow-auto border border-line/40 rounded-[var(--radius-sm)]">
            <table className="w-full text-[14px]">
              <thead className="sticky top-0 bg-bg text-dim text-[11px] uppercase tracking-wide">
                <tr><th className="text-left px-2 py-1.5">Model</th><th className="text-right px-2 py-1.5">Default</th><th className="text-right px-2 py-1.5">Override</th><th className="text-right px-2 py-1.5">Effective</th><th className="px-2 py-1.5"></th></tr>
              </thead>
              <tbody>
                {filtered.map((m) => {
                  const key = `${m.provider}/${m.id}`;
                  const isModified = overrides[key] !== undefined;
                  const value = draft[key] ?? (isModified ? String(overrides[key]) : "");
                  return (
                    <tr key={key} className={`border-t border-line/20 ${isModified ? "bg-warn/5" : ""}`}>
                      <td className="px-2 py-1.5"><span className="block truncate max-w-[260px]">{m.name ?? m.id}</span><span className="text-[11px] text-dim">{key}</span></td>
                      <td className="px-2 py-1.5 text-right text-dim">{formatNumber(m.contextWindow)}</td>
                      <td className="px-2 py-1.5 text-right"><input type="number" inputMode="numeric" min={0} placeholder="—" value={value} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} onBlur={(e) => commit(m.provider, m.id, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="settings-input w-[120px] text-right" aria-label={`Override for ${key}`} /></td>
                      <td className="px-2 py-1.5 text-right">{formatNumber(effective(m))}</td>
                      <td className="px-2 py-1.5 text-right">{isModified ? <button onClick={() => { const next = { ...overrides }; delete next[key]; onSave({ contextWindowOverrides: next }); setDraft((d) => { const c = { ...d }; delete c[key]; return c; }); }} className="text-[11px] text-dim hover:text-fg">↺</button> : null}</td>
                    </tr>
                  );
                })}
                {!filtered.length ? <tr><td colSpan={5} className="px-2 py-6 text-center text-dim">No models match.</td></tr> : null}
              </tbody>
            </table>
          </div>
        )}
      </SettingSection>
    </div>
  );
}
