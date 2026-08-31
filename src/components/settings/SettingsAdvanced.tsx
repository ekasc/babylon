import { useState } from "react";
import type { PiSettings } from "../../bridge";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";

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
      const parsed = JSON.parse(text);
      const { bridge } = await import("../../bridge");
      await bridge.setSettings(parsed);
      setMsg(`Imported ${file.name}`); setTimeout(() => setMsg(null), 2000);
    } catch (e: any) { setMsg(e?.message ?? "Invalid file"); }
  };
  const electronVer = (window as any).process?.versions?.electron;
  const nodeVer = (window as any).process?.versions?.node;
  const verText = [electronVer ? `Electron ${electronVer}` : null, nodeVer ? `Node ${nodeVer}` : null].filter(Boolean).join(" · ") || "Runtime versions unavailable outside Electron";
  return (
    <div>
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Advanced</h2>
      <p className="text-[15px] leading-6 text-fg/60 mt-2">Expert controls and diagnostics.</p>

      <SettingSection title="Data & storage" hint="Read-only locations. No secrets are shown.">
        <div className="rounded-md border border-line/30 overflow-hidden divide-y divide-line/20">
          <SettingRow title="Settings file" description="~/Library/Application Support/Babylon/pideck-settings.json" control={<span className="text-[11px] font-mono text-dim">JSON</span>} />
          <SettingRow title="State directory" description="…/pideck-state (snapshots, rollbacks, recaps)" control={<span className="text-[11px] text-dim">on disk</span>} />
          <SettingRow title="Babylon" description="0.1.0" control={<span className="text-[11px] font-mono text-dim">app</span>} />
          <SettingRow title="Runtime" description={verText} control={null as any} />
        </div>
      </SettingSection>

      <SettingSection title="Settings management">
        <div className="space-y-3 max-w-[640px]">
          <div className="flex gap-2">
            <button onClick={doExport} className="rounded-md border border-line px-3 py-1.5 text-[12.5px] hover:bg-inset">Export settings</button>
            <label className="rounded-md border border-line px-3 py-1.5 text-[12.5px] hover:bg-inset cursor-pointer">Import from file<input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImportFile(f); e.currentTarget.value = ""; }} /></label>
            <button onClick={() => { if (confirm("Reset all settings to defaults?")) { onSave({ chatModel: undefined as any, chatReasoning: undefined as any, titleModel: undefined as any, titleReasoning: undefined as any, gitCommitModel: undefined as any, gitCommitPrompt: undefined as any, contextWindowOverrides: {}, appearance: { theme: "system", useSystemFonts: true, monoFontFamily: "system" }, compaction: { mode: "summary" }, daemon: {} }); setMsg("Reset to defaults"); setTimeout(()=>setMsg(null),1500); } }} className="rounded-md border border-err/30 text-err px-3 py-1.5 text-[12.5px] hover:bg-err/10">Reset everything</button>
            {msg ? <span className="text-[12px] text-dim self-center">{msg}</span> : null}
          </div>
        </div>
      </SettingSection>
    </div>
  );
}
