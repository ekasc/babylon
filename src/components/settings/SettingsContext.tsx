import { useMemo, useState } from "react";
import type { PiSettings } from "../../bridge";
import { SettingSection } from "./SettingSection";
import { filterModels, getProviders } from "../../lib/model-helpers";
import { filterModelsEffect, getProvidersEffect } from "../../lib/model-helpers.effect";
import * as Effect from "effect/Effect";
import { formatNumber } from "../../lib/format";
import { formatNumberEffect } from "../../lib/format.effect";
import { modelSupportsImages } from "../../../electron/snapcompact/model-profiles";

type Mode = "summary" | "automatic" | "snapcompact";

export function SettingsContext({
  models,
  agentState,
  settings,
  onSave,
}: {
  models: any[];
  agentState: any | null;
  settings: PiSettings | null;
  onSave: (p: Partial<PiSettings>) => void;
}) {
  const mode: Mode = (settings?.compaction?.mode as Mode) ?? "summary";
  const [q, setQ] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const overrides = settings?.contextWindowOverrides ?? {};

  const currentModel: any = agentState?.model ?? null;
  const supportsVision = !!(
    modelSupportsImages(currentModel) ||
    currentModel?.supportsImages ||
    currentModel?.vision ||
    currentModel?.capabilities?.vision
  );

  const effective = (m: any) => {
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

  const filtered = useMemo(() => Effect.runSync(filterModelsEffect(models, q, providerFilter)), [models, q, providerFilter]);

  const providers = useMemo(() => Effect.runSync(getProvidersEffect(models)), [models]);
  const modifiedCount = Object.keys(overrides).length;

  return (
    <div>
      <h2 className="text-[24px] font-semibold tracking-[-0.015em]">Context</h2>
      <p className="text-[15px] leading-6 text-fg/60 mt-2">Compaction and context-window behaviour.</p>

      <SettingSection title="Compaction strategy">
        <div className="space-y-2 max-w-[560px]">
          {(["summary", "automatic", "snapcompact"] as Mode[]).map((m) => (
            <label key={m} className={`flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer ${mode === m ? "border-accent bg-accent/5" : "border-line/40 hover:bg-inset/40"}`}>
              <input type="radio" name="compaction" checked={mode === m} onChange={() => onSave({ compaction: { mode: m } })} className="mt-1" />
              <span className="flex-1">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {m === "summary" ? "Summary" : m === "automatic" ? "Automatic" : "Snapcompact"}
                  {m === "snapcompact" ? <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">Experimental</span> : null}
                </span>
                <span className="block text-[13px] leading-5 text-fg/60">
                  {m === "summary" ? "Traditional text compaction." : m === "automatic" ? "Babylon chooses based on model capabilities." : "Bitmap-backed historical context for vision models."}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3 rounded-md border border-line/30 bg-inset/30 px-4 py-3 text-[13px] leading-6 max-w-[560px]">
          <div className="flex gap-2"><span className="text-dim">Current model</span><span className="font-mono">{currentModel ? `${currentModel.provider}/${currentModel.id}` : "— (no active session)"}</span></div>
          <div className="flex gap-2"><span className="text-dim">Vision support</span><span>{currentModel ? (supportsVision ? "Yes" : "No") : "—"}</span></div>
          <div className="flex gap-2"><span className="text-dim">Effective strategy</span><span className="font-medium">{mode === "automatic" ? (supportsVision ? "Snapcompact" : "Summary") : mode === "snapcompact" && !supportsVision ? "Summary (fallback)" : mode}</span></div>
          {mode === "snapcompact" && !supportsVision && currentModel ? <p className="mt-1 text-dim">Current model does not support images. Snapcompact will fall back safely.</p> : null}
        </div>
      </SettingSection>

      <SettingSection title="Context window overrides" hint="Expert overrides per model. Incorrect values can cause premature compaction or provider request failures.">
        <div className="flex gap-2 mb-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models…" className="settings-input flex-1" />
          <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="settings-input w-[160px]">
            <option value="all">All providers</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {modifiedCount ? <button onClick={() => onSave({ contextWindowOverrides: {} })} className="rounded-md border border-line px-3 text-[12px] hover:border-err hover:text-err">Reset all</button> : null}
        </div>
        {!models.length ? <p className="text-[12px] text-dim">No models available.</p> : (
          <div className="max-h-[480px] overflow-auto border border-line/40 rounded-md">
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
                    <tr key={key} className={`border-t border-line/20 ${isModified ? "bg-amber-500/5" : ""}`}>
                      <td className="px-2 py-1.5"><span className="block truncate max-w-[260px]">{m.name ?? m.id}</span><span className="font-mono text-[11px] text-dim">{key}</span></td>
                      <td className="px-2 py-1.5 text-right font-mono text-dim">{Effect.runSync(formatNumberEffect(m.contextWindow))}</td>
                      <td className="px-2 py-1.5 text-right"><input type="number" inputMode="numeric" min={0} placeholder="—" value={value} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} onBlur={(e) => commit(m.provider, m.id, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="settings-input w-[120px] text-right" aria-label={`Override for ${key}`} /></td>
                      <td className="px-2 py-1.5 text-right font-mono">{Effect.runSync(formatNumberEffect(effective(m)))}</td>
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
