import { useMemo, useState } from "react";
import ModelPicker from "../ModelPicker";
import ThinkingPicker from "./SettingsThinkingPicker";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";
import { filterModels, findModel, getProviders } from "../../lib/model-helpers";
import { formatContextWindow } from "../../lib/format";
import { Select, SelectOption } from "../ui/Select";
import { modelSupportsImages } from "../../../electron/snapcompact/model-profiles";
import type { AgentModel, AgentState, PiSettings } from "../../bridge";

export function SettingsModels({
  models,
  agentState,
  settings,
  onSave,
}: {
  models: AgentModel[];
  agentState: AgentState | null;
  settings: PiSettings | null;
  onSave: (patch: Partial<PiSettings>) => void;
}) {
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState<string>("all");

  const chatModel = agentState?.model ?? null;
  const defaultChatRef = settings?.chatModel;

  const titleModel = useMemo(() => findModel(models, settings?.titleModel ?? null), [settings?.titleModel, models]);
  const imageModel = useMemo(() => findModel(models, settings?.imageModel ?? null), [settings?.imageModel, models]);
  const visionModels = useMemo(
    () => models.filter((m) => modelSupportsImages(m) || m.supportsImages || m.vision),
    [models]
  );

  const providers = useMemo(() => getProviders(models), [models]);

  const filtered = useMemo(() => filterModels(models, q, provider), [models, q, provider]);

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Models</h2>
      <p className="text-[13px] leading-5 text-dim mt-1">Configure models used by Babylon. “Current” is the live session, “Default” persists for new sessions.</p>

      <div className="mt-6 border-t border-line">
        <SettingRow
          title="Title model"
          control={
            <div className="flex items-center gap-2">
              <ModelPicker models={models} current={titleModel} disabled={!models.length} align="right" wide onSelect={(p, id) => onSave({ titleModel: { provider: p, modelId: id } })} />
              <ThinkingPicker current={settings?.titleReasoning ?? "low"} disabled={!settings} onSelect={(l) => onSave({ titleReasoning: l })} />
            </div>
          }
        />
        <SettingRow
          title="Image model"
          description="Reads attached images (screenshots, diagrams, photos) when the chat model has no vision — the image model describes them and that description is handed to the session instead of the raw image."
          control={
            <div className="flex items-center gap-2">
              <ModelPicker models={visionModels} current={imageModel} disabled={!visionModels.length} align="right" wide onSelect={(p, id) => onSave({ imageModel: { provider: p, modelId: id } })} />
              {imageModel ? (
                <button
                  onClick={() => onSave({ imageModel: undefined })}
                  className="rounded-md border border-line px-2 py-1 text-[12px] text-dim hover:bg-inset hover:text-fg"
                >
                  Clear
                </button>
              ) : null}
            </div>
          }
        />
      </div>

      <SettingSection title="Model catalogue" hint={`${filtered.length} of ${models.length} models · ${providers.length} providers`}>
        <div>
        <div className="flex gap-3 mb-3 w-full">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dim text-[13px]">⌕</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, provider or ID…"
              className="settings-input w-full pl-8 text-[14px]"
            />
          </div>
          <Select value={provider} onChange={setProvider} triggerClassName="settings-input w-[200px] shrink-0 text-[14px]">
            <SelectOption value="all" label="All providers" />
            {providers.map((p) => <SelectOption key={p} value={p}>{p}</SelectOption>)}
          </Select>
        </div>

        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-raised">
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full table-fixed">
              <thead className="sticky top-0 z-[1] bg-raised/90 backdrop-blur-sm border-b border-line">
                <tr className="text-[11px] font-medium tracking-[0.04em] uppercase text-dim">
                  <th className="text-left font-medium px-4 py-2.5">Model</th>
                  <th className="text-left font-medium px-3 py-2.5 w-[180px]">Provider</th>
                  <th className="text-right font-medium px-3 py-2.5 w-[110px]">Context</th>
                  <th className="text-center font-medium px-3 py-2.5 w-[90px]">Vision</th>
                  <th className="w-[160px]"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((m) => {
                  const key = `${m.provider}/${m.id}`;
                  const isDefault = defaultChatRef?.provider === m.provider && defaultChatRef?.modelId === m.id;
                  const isCurrent = chatModel?.provider === m.provider && chatModel?.id === m.id;
                  return (
                    <tr key={key} className="group hover:bg-inset transition-colors">
                      <td className="px-4 py-3">
                        <div className="text-[14px] font-[500] tracking-[-0.01em] text-fg leading-4 truncate max-w-[360px]">{m.name ?? m.id}</div>
                        <div className="mt-0.5 text-[12px] leading-3 text-dim truncate max-w-[360px]">{m.id}</div>
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-2 text-[13px] text-fg/80 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-accent shrink-0" />
                          {m.provider}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] text-dim">{formatContextWindow(m.contextWindow)}</td>
                      <td className="px-3 py-3 text-center">
                        {modelSupportsImages(m) || m.supportsImages || m.vision ? <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-ok text-bg text-[10px]">◉</span> : <span className="text-dim">—</span>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-1.5">
                          {isDefault ? <span className="inline-flex items-center rounded-full border border-accent/25 bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">Default</span> : null}
                          {isCurrent ? <span className="inline-flex items-center rounded-full bg-accent text-bg px-2 py-0.5 text-[11px] font-medium">Current</span> : null}
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
          <div className="border-t border-line bg-inset/20 px-4 py-2 flex items-center justify-between text-[12px] text-dim">
            <span>{filtered.length} shown</span>
            <span className="hidden sm:inline">Git commit model is set in <span className="text-fg/70 font-medium">Git</span></span>
          </div>
        </div>
        </div>
      </SettingSection>
    </div>
  );
}
