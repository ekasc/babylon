import { useState } from "react";
import type { PiSettings } from "../../bridge";
import { errorMessage } from "../../lib/errors";
import { confirmAction } from "../../lib/prompts";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";

const DEFAULT_RESET: Partial<PiSettings> = {
  chatModel: undefined,
  chatReasoning: undefined,
  titleModel: undefined,
  titleReasoning: undefined,
  gitCommitModel: undefined,
  gitCommitPrompt: undefined,
  contextWindowOverrides: {},
  appearance: { theme: "system", useSystemFonts: true, monoFontFamily: "system" },
  compaction: { mode: "summary" },
  daemon: {},
};

export function SettingsAdvanced({ settings, onSave }: { settings: PiSettings | null; onSave: (p: Partial<PiSettings>) => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const doExport = () => {
    const blob = new Blob([JSON.stringify(settings ?? {}, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "babylon-settings.json"; a.click(); URL.revokeObjectURL(url);
  };
  const doImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const { bridge } = await import("../../bridge");
      const { toSettingsPatch } = await import("../../lib/settings-patch");
      await bridge.setSettings(toSettingsPatch(parsed));
      setMsg(`Imported ${file.name}`); setTimeout(() => setMsg(null), 2000);
    } catch (e) { setMsg(errorMessage(e, "Invalid file")); }
  };
  const versions = (window as { process?: { versions?: { electron?: string; node?: string } } }).process?.versions;
  const electronVer = versions?.electron;
  const nodeVer = versions?.node;
  const verText = [electronVer ? `Electron ${electronVer}` : null, nodeVer ? `Node ${nodeVer}` : null].filter(Boolean).join(" · ") || "Runtime versions unavailable outside Electron";
  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Advanced</h2>
      <p className="text-[13px] leading-5 text-dim mt-1">Expert controls and diagnostics.</p>

      <SettingSection title="Data & storage" hint="Read-only locations. No secrets are shown.">
        <div className="border-t border-line">
          <SettingRow title="Settings file" description="~/Library/Application Support/Babylon/pideck-settings.json" control={<span className="text-[11px] text-dim">JSON</span>} />
          <SettingRow title="State directory" description="…/pideck-state (snapshots, rollbacks, recaps)" control={<span className="text-[11px] text-dim">on disk</span>} />
          <SettingRow title="Babylon" description="0.1.0" control={<span className="text-[11px] text-dim">app</span>} />
          <SettingRow title="Runtime" description={verText} />
        </div>
      </SettingSection>

      <SettingSection title="Settings management">
        <div className="flex gap-2 max-w-[640px]">
          <button onClick={doExport} className="rounded-[var(--radius-sm)] border border-line px-3 py-1.5 text-[13px] hover:bg-inset">Export settings</button>
          <label className="rounded-[var(--radius-sm)] border border-line px-3 py-1.5 text-[13px] hover:bg-inset cursor-pointer">Import from file<input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImportFile(f); e.currentTarget.value = ""; }} /></label>
          <button onClick={async () => { if (await confirmAction({ title: "Reset all settings to defaults?", message: "Export first if you want a backup.", confirmLabel: "Reset everything", danger: true })) { onSave(DEFAULT_RESET); setMsg("Reset to defaults"); setTimeout(()=>setMsg(null),1500); } }} className="rounded-[var(--radius-sm)] border border-err/30 text-err px-3 py-1.5 text-[13px] hover:bg-err/10">Reset everything</button>
          {msg ? <span className="text-[12px] text-dim self-center">{msg}</span> : null}
        </div>
      </SettingSection>
    </div>
  );
}
