import { useEffect, useMemo, useState } from "react";
import type { PiSettings } from "../../bridge";
import { applyMonoFont, applySystemFonts, applyTheme, monoStack, MONO_FONTS, type ThemePref } from "../../lib/theme";
import { SettingSection } from "./SettingSection";

function ThemePreview({ mode, active }: { mode: ThemePref; active: boolean }) {
  const isDark = mode === "dark";
  const isSystem = mode === "system";
  return (
    <div className={`rounded-md border overflow-hidden ${active ? "border-accent" : "border-line/40"}`}>
      <div className={isDark ? "bg-[#1a1a1a] text-zinc-100" : isSystem ? "bg-[#f6f6f6] text-zinc-900" : "bg-white text-zinc-900"}>
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-black/10">
          <span className="h-2 w-2 rounded-full bg-red-400" /><span className="h-2 w-2 rounded-full bg-yellow-400" /><span className="h-2 w-2 rounded-full bg-green-400" />
          <span className="ml-2 text-[10px] tracking-wide uppercase opacity-60">{mode}</span>
        </div>
        <div className="p-2 space-y-1">
          <div className={`h-2 w-3/4 rounded ${isDark ? "bg-white/20" : "bg-black/10"}`} />
          <div className={`h-2 w-1/2 rounded ${isDark ? "bg-white/10" : "bg-black/5"}`} />
        </div>
      </div>
    </div>
  );
}

export function SettingsAppearance({ settings, onSave, theme, onThemeChange }: { settings: PiSettings | null; onSave: (p: Partial<PiSettings>) => void; theme: ThemePref; onThemeChange: (t: ThemePref) => void }) {
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const currentFamily = settings?.appearance?.monoFontFamily ?? "system";

  useEffect(() => {
    void (async () => {
      let fonts: string[] = [];
      try {
        if ("queryLocalFonts" in window) {
          const localFonts: Array<{ family: string }> = await (window as any).queryLocalFonts();
          fonts = [...new Set(localFonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
        }
      } catch {}
      if (!fonts.length) {
        try { const { bridge } = await import("../../bridge"); const fromMain = await bridge.listFonts(); if (Array.isArray(fromMain) && fromMain.length) fonts = fromMain; } catch {}
      }
      if (fonts.length) setSystemFonts(fonts); else setSystemFonts(MONO_FONTS.map((f) => f.id));
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = systemFonts.length ? systemFonts : MONO_FONTS.map((f) => f.id);
    const base = ["system", ...list.filter((f) => f !== "system")];
    if (!q) return base.slice(0, 400);
    return base.filter((f) => f.toLowerCase().includes(q)).slice(0, 400);
  }, [systemFonts, filter]);

  const setTheme = (t: ThemePref) => { applyTheme(t); onThemeChange(t); onSave({ appearance: { ...(settings?.appearance ?? {}), theme: t } }); };

  return (
    <div>
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Appearance</h2>
      <p className="text-[15px] leading-6 text-fg/60 mt-2">Theme and typography.</p>

      <SettingSection title="Theme">
        <div className="grid grid-cols-3 gap-3 max-w-[560px]">
          {(["light", "dark", "system"] as ThemePref[]).map((t) => (
            <button key={t} onClick={() => setTheme(t)} aria-pressed={theme === t} className="text-left">
              <ThemePreview mode={t} active={theme === t} />
              <span className={`mt-1.5 block text-[12.5px] ${theme === t ? "font-medium text-fg" : "text-dim"}`}>{t === "system" ? "System" : t === "dark" ? "Dark" : "Light"}</span>
            </button>
          ))}
        </div>
      </SettingSection>

      <SettingSection title="Typography" hint="Pick any font installed on this Mac — no font files are shipped. Preview shows the monospace stack.">
        <label className="flex items-center justify-between rounded-md px-3 py-2.5 hover:bg-inset cursor-pointer border border-transparent hover:border-line/30">
          <span className="text-[13px]">Use system fonts</span>
          <input type="checkbox" checked={settings?.appearance?.useSystemFonts ?? true} onChange={(e) => { const enabled = e.target.checked; applySystemFonts(enabled); localStorage.setItem("babylon:useSystemFonts", String(enabled)); onSave({ appearance: { ...(settings?.appearance ?? {}), useSystemFonts: enabled } }); }} className="h-4 w-4 accent-accent" />
        </label>
        <div className="mt-3 max-w-[480px]">
          <label className="block text-[12px] font-medium text-dim mb-1.5">Monospace font</label>
          <div className="relative">
            <button onClick={() => setOpen((v) => !v)} className="w-full rounded-md border border-line/40 bg-inset/30 px-3 py-2 text-left flex items-center justify-between hover:bg-bg" aria-haspopup="listbox" aria-expanded={open}>
              <span style={{ fontFamily: monoStack(currentFamily) }} className="truncate text-[13px]">{currentFamily}</span>
              <span className="text-dim text-[11px]">▾</span>
            </button>
            {open ? (
              <div className="absolute z-20 mt-1 w-full rounded-md border border-line bg-bg shadow-lg max-h-[320px] flex flex-col overflow-hidden">
                <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search fonts…" className="m-2 rounded-md border border-line bg-inset/30 px-2.5 py-1.5 text-[12.5px] outline-none" />
                <div className="overflow-auto flex-1 divide-y divide-line/10">
                  {filtered.map((f) => (
                    <button key={f} onClick={() => { applyMonoFont(f); onSave({ appearance: { ...(settings?.appearance ?? {}), monoFontFamily: f, useSystemFonts: true } }); setOpen(false); }} className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-inset ${f === currentFamily ? "bg-inset font-medium" : ""}`} style={{ fontFamily: monoStack(f) }}>{f}</button>
                  ))}
                </div>
                <div className="px-3 py-1.5 text-[11px] text-dim border-t border-line/20">{systemFonts.length ? `${systemFonts.length} fonts` : "Loading…"} · {filtered.length} shown</div>
              </div>
            ) : null}
          </div>
          <div className="mt-2 rounded-md border border-line/30 bg-inset/20 px-3 py-2.5">
            <p className="text-[11px] font-medium tracking-wide uppercase text-dim">Preview — {currentFamily}</p>
            <p className="mt-1 truncate text-[13px]" style={{ fontFamily: monoStack(currentFamily) }}>{`const answer = 42 // ${currentFamily}`}</p>
            <p className="truncate text-[13px]" style={{ fontFamily: monoStack(currentFamily) }}>The quick brown fox jumps 0123456789</p>
          </div>
        </div>
      </SettingSection>
    </div>
  );
}
