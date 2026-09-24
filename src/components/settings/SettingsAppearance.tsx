import { useEffect, useMemo, useRef, useState } from "react";
import type { PiSettings } from "../../bridge";
import { applyMonoFont, applySystemFonts, applyTheme, applyThemeId, monoStack, MONO_FONTS, type ThemeId, type ThemePref } from "../../lib/theme";
import { setWithFallback } from "../../lib/storage";
import { useBoolPref, useStringPref, writeBoolPref, writeStringPref } from "../../lib/prefs";
import { SettingSection } from "./SettingSection";
import { SettingToggle } from "./SettingToggle";
import { PopoverPanel, PopoverRoot, PopoverTrigger } from "../ui/Popover";

// Free-range, not presets. Three isolated knobs (cf. t3code appearance,
// MIT): message text scales the conversation; prompt only the composer
// input; code only code surfaces. Chrome stays fixed, so no knob breaks it.
const CHAT_FONT_MIN = 11;
const CHAT_FONT_MAX = 24;
const CHAT_FONT_DEFAULT = 14;
const PROMPT_FONT_MIN = 12;
const PROMPT_FONT_MAX = 20;
const PROMPT_FONT_DEFAULT = 14;
const CODE_FONT_MIN = 10;
const CODE_FONT_MAX = 18;
const CODE_FONT_DEFAULT = 13;

function FontSizeRow({
  label,
  description,
  min,
  max,
  fallback,
  prefKey,
}: {
  label: string;
  description: string;
  min: number;
  max: number;
  fallback: number;
  prefKey: "chatFont" | "promptFont" | "codeFont";
}) {
  const raw = useStringPref(prefKey, String(fallback));
  const value = Math.min(max, Math.max(min, Number(raw) || fallback));
  return (
    <div className="max-w-[520px] py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-fg">{label}</span>
        <button
          onClick={() => writeStringPref(prefKey, String(fallback))}
          className="shrink-0 text-[12px] text-dim hover:text-fg"
        >
          Reset
        </button>
      </div>
      <p className="mt-0.5 text-[12px] text-dim">{description}</p>
      <div className="mt-1.5 flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => writeStringPref(prefKey, e.target.value)}
          aria-label={label}
          className="h-6 flex-1 cursor-pointer accent-[var(--accent)]"
        />
        <input
          type="number"
          value={Number(raw) || fallback}
          onChange={(e) => writeStringPref(prefKey, e.target.value)}
          aria-label={`${label} in pixels`}
          className="w-16 shrink-0 rounded-[var(--radius-sm)] border border-line/40 bg-transparent px-2 py-1 text-right text-[13px] tabular-nums text-fg outline-none focus:border-accent"
        />
        <span className="shrink-0 text-[13px] text-dim">px</span>
      </div>
    </div>
  );
}

function ModePreview({ mode, active }: { mode: ThemePref; active: boolean }) {
  const isDark = mode === "dark";
  const isSystem = mode === "system";
  const bg = isDark ? "bg-[#1a1a1a] text-zinc-100" : isSystem ? "bg-[#f6f6f6] text-zinc-900" : "bg-white text-zinc-900";
  return (
    <div className={`rounded-md border overflow-hidden ${active ? "border-accent" : "border-line/40"}`}>
      <div className={bg}>
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
function ThemeIdPreview({ id, active }: { id: ThemeId; active: boolean }) {
  const isExcal = id === "excalidraw";
  const bg = isExcal ? "bg-[#fdf8ef] text-[#1a1a1a]" : "bg-white text-zinc-900";
  const label = isExcal ? "EXCALI" : "TERMINAL";
  return (
    <div className={`rounded-md border overflow-hidden ${active ? "border-accent" : "border-line/40"} ${isExcal ? "rotate-[-0.5deg]" : ""}`} style={isExcal ? { borderRadius: "255px 15px 225px 15px / 15px 225px 15px 255px" } : undefined}>
      <div className={bg}>
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-black/10">
          <span className="h-2 w-2 rounded-full bg-red-400" /><span className="h-2 w-2 rounded-full bg-yellow-400" /><span className="h-2 w-2 rounded-full bg-green-400" />
          <span className="ml-2 text-[10px] tracking-wide uppercase opacity-60" style={isExcal ? { fontFamily: '"Virgil", cursive' } : undefined}>{label}</span>
        </div>
        <div className="p-2 space-y-1">
          <div className={`h-2 w-3/4 rounded ${isExcal ? "bg-[#e8dcc6]" : "bg-black/10"}`} style={isExcal ? { borderRadius: "255px 15px" } : undefined} />
          <div className={`h-2 w-1/2 rounded ${isExcal ? "bg-[#e8dcc6]/70" : "bg-black/5"}`} />
        </div>
      </div>
    </div>
  );
}

export function SettingsAppearance({ settings, onSave, theme, onThemeChange, themeId, onThemeIdChange }: { settings: PiSettings | null; onSave: (p: Partial<PiSettings>) => void; theme: ThemePref; onThemeChange: (t: ThemePref) => void; themeId: ThemeId; onThemeIdChange: (id: ThemeId) => void }) {
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const streamResponses = useBoolPref("streamResponses", false);
  const fontRootRef = useRef<HTMLDivElement>(null);
  const currentFamily = settings?.appearance?.monoFontFamily ?? "system";

  useEffect(() => {
    void (async () => {
      let fonts: string[] = [];
      try {
        if ("queryLocalFonts" in window) {
          const withFonts = window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> };
          const localFonts: Array<{ family: string }> = await withFonts.queryLocalFonts?.() ?? [];
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

  const setTheme = (t: ThemePref) => { applyTheme(t); onThemeChange(t); onSave({ appearance: { ...(settings?.appearance ?? {}), theme: t as "light" | "dark" | "system" } }); };
  const setThemeId = (id: ThemeId) => { applyThemeId(id); onThemeIdChange(id); };
  const setUseSystemFonts = (enabled: boolean) => { applySystemFonts(enabled); setWithFallback("useSystemFonts", String(enabled)); onSave({ appearance: { ...(settings?.appearance ?? {}), useSystemFonts: enabled } }); };

  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Appearance</h2>
      <p className="text-[13px] leading-5 text-dim mt-1">Theme and typography.</p>

      <SettingSection title="Mode" hint="Light / Dark mirrors Pi, System follows OS">
        <div className="grid grid-cols-3 gap-3 max-w-[480px]">
          {( ["light", "dark", "system"] as ThemePref[]).map((t) => (
            <button key={t} onClick={() => setTheme(t)} aria-pressed={theme === t} className="text-left">
              <ModePreview mode={t} active={theme === t} />
              <span className={`mt-1.5 block text-[13px] ${theme === t ? "font-medium text-fg" : "text-dim"}`}>{t === "system" ? "System" : t === "dark" ? "Dark" : "Light"}</span>
            </button>
          ))}
        </div>
      </SettingSection>
      <SettingSection title="Theme" hint="Each theme has its own Light + Dark, pick the sketch.">
        <div className="grid grid-cols-2 gap-3 max-w-[480px]">
          {( ["terminal", "excalidraw"] as ThemeId[]).map((id) => (
            <button key={id} onClick={() => setThemeId(id)} aria-pressed={themeId === id} className="text-left">
              <ThemeIdPreview id={id} active={themeId === id} />
              <span className={`mt-1.5 block text-[13px] ${themeId === id ? "font-medium text-fg" : "text-dim"}`}>{id === "excalidraw" ? "Excalidraw" : "Terminal"}</span>
            </button>
          ))}
        </div>
      </SettingSection>

      <SettingSection title="Typography" hint="Pick any font installed on this Mac, no font files are shipped. Preview shows the monospace stack.">
        <SettingToggle label="Use system fonts" checked={settings?.appearance?.useSystemFonts ?? true} onChange={setUseSystemFonts} />
        <div className="mt-3 max-w-[480px]">
          <label className="block text-[12px] font-medium text-dim mb-1.5">Monospace font</label>
          <div ref={fontRootRef} className="relative">
            <PopoverRoot open={open} onOpenChange={setOpen}>
            <PopoverTrigger className="w-full rounded-[var(--radius-sm)] border border-line/40 bg-inset/30 px-3 py-2 text-left flex items-center justify-between hover:bg-bg">
              <span style={{ fontFamily: monoStack(currentFamily) }} className="truncate text-[13px]">{currentFamily}</span>
              <span className="text-dim text-[11px]">▾</span>
            </PopoverTrigger>
            <PopoverPanel
              container={fontRootRef.current}
              side="bottom"
              align="start"
              sideOffset={4}
              positionerClassName="z-50"
              className="w-full rounded-[var(--radius-sm)] border border-line bg-bg shadow-lg max-h-[320px] flex flex-col overflow-hidden"
            >
                <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search fonts…" className="m-2 rounded-[var(--radius-sm)] border border-line bg-inset/30 px-2.5 py-1.5 text-[13px] outline-none" />
                <div className="overflow-auto flex-1 divide-y divide-line/10">
                  {filtered.map((f) => (
                    <button key={f} onClick={() => { applyMonoFont(f); onSave({ appearance: { ...(settings?.appearance ?? {}), monoFontFamily: f, useSystemFonts: true } }); setOpen(false); }} className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-inset ${f === currentFamily ? "bg-inset font-medium" : ""}`} style={{ fontFamily: monoStack(f) }}>{f}</button>
                  ))}
                </div>
                <div className="px-3 py-1.5 text-[11px] text-dim border-t border-line/20">{systemFonts.length ? `${systemFonts.length} fonts` : "Loading…"} · {filtered.length} shown</div>
            </PopoverPanel>
            </PopoverRoot>
          </div>
          <div className="mt-2 rounded-[var(--radius-sm)] border border-line/30 bg-inset/20 px-3 py-2.5">
            <p className="text-[11px] font-medium tracking-wide uppercase text-dim">Preview, {currentFamily}</p>
            <p className="mt-1 truncate text-[13px]" style={{ fontFamily: monoStack(currentFamily) }}>{`const answer = 42 // ${currentFamily}`}</p>
            <p className="truncate text-[13px]" style={{ fontFamily: monoStack(currentFamily) }}>The quick brown fox jumps 0123456789</p>
          </div>
        </div>
      </SettingSection>

      <SettingSection title="Chat text" hint="Three isolated sizes: messages, the prompt box, and code. Chrome stays fixed.">
        <FontSizeRow
          label="Message text"
          description="Messages, headings, and dialog text."
          min={CHAT_FONT_MIN}
          max={CHAT_FONT_MAX}
          fallback={CHAT_FONT_DEFAULT}
          prefKey="chatFont"
        />
        <FontSizeRow
          label="Prompt text"
          description="Only the box you write prompts in."
          min={PROMPT_FONT_MIN}
          max={PROMPT_FONT_MAX}
          fallback={PROMPT_FONT_DEFAULT}
          prefKey="promptFont"
        />
        <FontSizeRow
          label="Code text"
          description="Code blocks, tool output, and diffs."
          min={CODE_FONT_MIN}
          max={CODE_FONT_MAX}
          fallback={CODE_FONT_DEFAULT}
          prefKey="codeFont"
        />
      </SettingSection>

      <SettingSection title="Conversation" hint="How assistant replies render in the transcript.">
        <SettingToggle label="Stream responses" checked={streamResponses} onChange={(v) => writeBoolPref("streamResponses", v)} />
      </SettingSection>
    </div>
  );
}
