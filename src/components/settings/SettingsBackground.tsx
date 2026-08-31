import { useEffect, useState } from "react";
import type { PiSettings } from "../../bridge";
import { SettingSection } from "./SettingSection";
import { SettingRow } from "./SettingRow";
import { bridge } from "../../bridge";

export function SettingsBackground({ settings, onSave }: { settings: PiSettings | null; onSave: (p: Partial<PiSettings>) => void }) {
  const enabled = settings?.daemon?.enabled ?? false;
  const [procs, setProcs] = useState<any[]>([]);
  useEffect(() => {
    bridge.processList().then(setProcs).catch(() => undefined);
    const off = bridge.onProcessUpdate(setProcs);
    return off;
  }, []);
  const running = procs.filter((p) => p.state === "running").length;

  return (
    <div>
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Background</h2>
      <p className="text-[15px] leading-6 text-fg/60 mt-2">Daemon and background execution.</p>
      <SettingSection title="Babylon daemon" hint="When enabled, Babylon spawns a standalone daemon at startup and keeps it running after the window closes, so background tasks survive the window.">
        <SettingRow
          title="Keep background runtime enabled"
          description={enabled ? "Daemon will stay alive after the window closes." : "Babylon stops when the window closes."}
          control={
            <label className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => onSave({ daemon: { enabled: e.target.checked } })} className="sr-only peer" />
              <div className="w-9 h-5 bg-line/60 rounded-full peer-checked:bg-accent transition-colors"></div>
              <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-bg rounded-full shadow peer-checked:translate-x-4 transition-transform"></div>
            </label>
          }
        />
        <div className="mt-4 grid grid-cols-3 gap-3 max-w-[640px]">
          <div className="rounded-md border border-line/30 bg-inset/20 px-3 py-2.5"><div className="text-[11px] tracking-wide uppercase text-dim">Status</div><div className="text-[13px] font-medium mt-0.5">{enabled ? "Enabled" : "Disabled"}</div></div>
          <div className="rounded-md border border-line/30 bg-inset/20 px-3 py-2.5"><div className="text-[11px] tracking-wide uppercase text-dim">Running processes</div><div className="text-[13px] font-medium mt-0.5">{running}</div></div>
          <div className="rounded-md border border-line/30 bg-inset/20 px-3 py-2.5"><div className="text-[11px] tracking-wide uppercase text-dim">Total</div><div className="text-[13px] font-medium mt-0.5">{procs.length}</div></div>
        </div>
        <p className="mt-2 text-[11px] text-dim">Requires restart to fully apply. Processes are managed by the runtime; daemon keeps them alive.</p>
      </SettingSection>
    </div>
  );
}
