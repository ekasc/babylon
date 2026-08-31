import { useEffect, useMemo, useState } from "react";
import type { PiSettings } from "../../bridge";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";
import ModelPicker from "../ModelPicker";
import { DEFAULT_GIT_COMMIT_PROMPT } from "../../lib/settings-shared";

export function SettingsGit({ settings, onSave, models }: { settings: PiSettings | null; onSave: (p: Partial<PiSettings>) => void; models: any[] }) {
  const [draft, setDraft] = useState(settings?.gitCommitPrompt ?? DEFAULT_GIT_COMMIT_PROMPT);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(settings?.gitCommitPrompt ?? DEFAULT_GIT_COMMIT_PROMPT); }, [settings?.gitCommitPrompt]);

  const gitModel = useMemo(() => {
    const ref = settings?.gitCommitModel;
    if (!ref) return null;
    return models.find((m) => m.provider === ref.provider && m.id === ref.modelId) ?? { provider: ref.provider, id: ref.modelId, name: ref.modelId };
  }, [settings?.gitCommitModel, models]);

  const isCustom = draft !== DEFAULT_GIT_COMMIT_PROMPT;
  const commitDraft = (val: string) => {
    setSaving(true);
    onSave({ gitCommitPrompt: val });
    setTimeout(() => setSaving(false), 400);
  };

  return (
    <div>
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Git</h2>
      <p className="text-[15px] leading-6 text-fg/60 mt-2">Commit generation and repository behaviour.</p>

      <SettingSection title="Commit generation" hint="Babylon always applies its built-in structured output and Unslop rules with low reasoning. Your instructions are appended.">
        <SettingRow
          title="Commit model"
          description="Model used to generate the commit message from the staged diff."
          control={<ModelPicker models={models} current={gitModel} disabled={!models.length} onSelect={(p, id) => onSave({ gitCommitModel: { provider: p, modelId: id } })} />}
        />
        <div className="mt-4 max-w-[720px]">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[12px] font-medium text-dim" htmlFor="git-prompt">Custom instructions</label>
            <span className="text-[11px] text-dim">{saving ? "Saving…" : isCustom ? "Customized" : "Default"} {isCustom ? <button onClick={() => { setDraft(DEFAULT_GIT_COMMIT_PROMPT); commitDraft(DEFAULT_GIT_COMMIT_PROMPT); }} className="ml-2 text-accent hover:underline">Reset</button> : null}</span>
          </div>
          <textarea
            id="git-prompt"
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitDraft(draft)}
            placeholder={DEFAULT_GIT_COMMIT_PROMPT}
            className="w-full rounded-md border border-line/40 bg-inset/30 px-3 py-2.5 font-mono text-[12.5px] leading-5 outline-none focus:border-accent focus:bg-bg"
          />
        </div>
      </SettingSection>
    </div>
  );
}
