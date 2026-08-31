import { useMemo, useState } from "react";
import ModelPicker from "./SettingsModelPicker";
import ThinkingPicker from "./SettingsThinkingPicker";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";
import { SettingsCard } from "./SettingsCard";
import { findModel, getProviders, filterModels } from "../../lib/model-helpers";
import { formatContextWindow } from "../../lib/format";
import { modelSupportsImages } from "../../../electron/snapcompact/model-profiles";
import type { PiSettings } from "../../bridge";

export function SettingsModels({
  models,
  thinkingLevels,
  agentState,
  settings,
  onSave,
  onSetModel,
  onSetThinking,
  saveError,
}: {
  models: any[];
  thinkingLevels: string[];
  agentState: any | null;
  settings: PiSettings | null;
  onSave: (patch: Partial<PiSettings>) => void;
  onSetModel: (p: string, id: string) => void;
  onSetThinking: (l: string) => void;
  saveError?: string | null;
}) {
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState<string>("all");

  const chatModel = agentState?.model ?? null;
  const chatReasoning = agentState?.thinkingLevel ?? settings?.chatReasoning ?? "off";
  const defaultChatRef = settings?.chatModel;

  const titleModel = useMemo(() => findModel(models, settings?.titleModel ?? null), [settings?.titleModel, models]);

  const providers = useMemo(() => getProviders(models), [models]);

  const filtered = useMemo(() => filterModels(models, q, provider), [models, q, provider]);

  return (
    <div>
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Models</h2>
      <p className="text-[15px] leading-6 text-fg/60 mt-2">Configure models used by Babylon. “Current” is the live session, “Default” persists for new sessions.</p>
      {saveError ? <p className="mt-3 rounded-md border border-err/20 bg-err/5 px-3 py-2 text-[13px] text-err">{saveError}</p> : null}

      <div className="space-y-3 mt-6">
        <SettingsCard accent>
          <SettingRow
            title="Chat model"
            description={agentState ? "Applies to current session and future sessions" : "Applies to future sessions"}
            control={
              <div className="flex items-center gap-2">
                <ModelPicker
                  models={models}
                  current={chatModel ?? (defaultChatRef ? models.find((m) => m.provider === defaultChatRef.provider && m.id === defaultChatRef.modelId) ?? null : null)}
                  disabled={!models.length}
                  onSelect={(p, id) => {
                    if (agentState) onSetModel(p, id);
                    onSave({ chatModel: { provider: p, modelId: id } });
                  }}
                />
                <ThinkingPicker
                  current={chatReasoning}
                  available={thinkingLevels}
                  disabled={!settings}
                  onSelect={(level) => {
                    if (agentState) onSetThinking(level);
                    onSave({ chatReasoning: level });
                  }}
                />
              </div>
            }
          />
        </SettingsCard>
        {!models.length ? <p className="text-[13px] text-white/50 px-1">No models loaded yet — they appear automatically once a session connects.</p> : null}
        <SettingsCard>
          <SettingRow
            title="Title model"
            description="Used for automatic names and recaps"
            control={
              <div className="flex items-center gap-2">
                <ModelPicker models={models} current={titleModel} disabled={!models.length} onSelect={(p, id) => onSave({ titleModel: { provider: p, modelId: id } })} />
                <ThinkingPicker current={settings?.titleReasoning ?? "low"} disabled={!settings} onSelect={(l) => onSave({ titleReasoning: l })} />
              </div>
            }
          />
        </SettingsCard>
      </div>

      <section className="py-6 border-b border-white/10 last:border-0">
        <div className="mb-4">
          <h3 className="text-[16px] font-semibold tracking-[-0.015em] text-white">Model catalogue</h3>
          <p className="mt-1.5 text-[13px] leading-5 text-white/60">{filtered.length} of {models.length} models · {providers.length} providers</p>
        </div>
        <div>
        <div className="flex gap-3 mb-3 w-full">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 text-[13px]">⌕</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, provider or ID…"
              className="settings-input w-full pl-8 text-[14px]"
            />
          </div>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className="settings-input w-[200px] shrink-0 text-[14px]">
            <option value="all">All providers</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full table-fixed">
              <thead className="sticky top-0 z-[1] bg-bg/90 backdrop-blur-sm border-b border-white/10">
                <tr className="text-[11px] font-medium tracking-[0.04em] uppercase text-white/60">
                  <th className="text-left font-medium px-4 py-2.5">Model</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[180px]">Provider</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[110px]">Context</th>
                  <th className="text-center font-medium px-3 py-2.5 w-[90px]">Vision</th>
                  <th className="w-[160px]"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {filtered.map((m) => {
                  const key = `${m.provider}/${m.id}`;
                  const isDefault = defaultChatRef?.provider === m.provider && defaultChatRef?.modelId === m.id;
                  const isCurrent = chatModel?.provider === m.provider && chatModel?.id === m.id;
                  return (
                    <tr key={key} className="group hover:bg-white/[0.04] transition-colors">
                      <td className="px-4 py-3">
                        <div className="text-[14px] font-[500] tracking-[-0.01em] text-fg leading-4 truncate max-w-[360px]">{m.name ?? m.id}</div>
                        <div className="mt-0.5 font-mono text-[11.5px] leading-3 text-white/65 truncate max-w-[360px]">{m.id}</div>
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-2 text-[13px] text-white/80 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-[var(--accent)] shrink-0" />
                          {m.provider}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-[13px] text-white/70">{formatContextWindow(m.contextWindow)}</td>
                      <td className="px-3 py-3 text-center">
                        {modelSupportsImages(m) || m.supportsImages || m.vision ? <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--ok)] text-black text-[10px]">◉</span> : <span className="text-white/25">—</span>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-1.5">
                          {isDefault ? <span className="inline-flex items-center rounded-full border border-[var(--accent)]/25 bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">Default</span> : null}
                          {isCurrent ? <span className="inline-flex items-center rounded-full bg-[var(--accent)] text-white px-2 py-0.5 text-[11px] font-medium">Current</span> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!filtered.length ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-16 text-center">
                      <div className="text-[14px] font-medium text-fg/60">No models match</div>
                      <div className="mt-1 text-[13px] text-fg/40">Try a different search or provider filter</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="border-t border-white/10 bg-white/[0.03] px-4 py-2 flex items-center justify-between text-[12px] text-white/50">
            <span>{filtered.length} shown</span>
            <span className="hidden sm:inline">Git commit model is set in <span className="text-white/70 font-medium">Git</span></span>
          </div>
        </div>
        </div>
      </section>
    </div>
  );
}
