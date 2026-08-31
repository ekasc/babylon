import { useEffect, useMemo, useRef, useState } from "react";
import { bridge, type PiSettings } from "../bridge";
import type { ThemePref } from "../lib/theme";
import { SettingsSidebar, type SettingsSectionId } from "./settings/SettingsSidebar";
import { SettingsModels } from "./settings/SettingsModels";
import { SettingsContext } from "./settings/SettingsContext";
import { SettingsPermissions } from "./settings/SettingsPermissions";
import { SettingsGit } from "./settings/SettingsGit";
import { SettingsBackground } from "./settings/SettingsBackground";
import { SettingsAppearance } from "./settings/SettingsAppearance";
import { SettingsAdvanced } from "./settings/SettingsAdvanced";

interface Props {
  models: any[];
  thinkingLevels: string[];
  agentState: any | null;
  onSetModel(provider: string, modelId: string): void;
  onSetThinking(level: string): void;
  theme: ThemePref;
  onThemeChange(theme: ThemePref): void;
  onClose(): void;
}

type SaveState = "idle" | "saving" | "error";
const SEARCH_INDEX: Array<{ id: SettingsSectionId; label: string; keywords: string; anchor?: string }> = [
  { id: "models", label: "Models › Default chat model", keywords: "model provider reasoning chat default current session" },
  { id: "models", label: "Models › Title generation", keywords: "title recap model reasoning" },
  { id: "models", label: "Models › Model catalogue", keywords: "catalogue list provider context window vision image" },
  { id: "context", label: "Context › Compaction", keywords: "compaction summary automatic snapcompact experimental vision fallback strategy" },
  { id: "context", label: "Context › Context window overrides", keywords: "context window override expert provider" },
  { id: "permissions", label: "Permissions › Rules", keywords: "permission rule allow deny policy mode" },
  { id: "git", label: "Git › Commit generation", keywords: "git commit prompt unslop message generation" },
  { id: "background", label: "Background › Daemon", keywords: "daemon background runtime keep enabled" },
  { id: "appearance", label: "Appearance › Theme", keywords: "theme light dark system appearance" },
  { id: "appearance", label: "Appearance › Typography", keywords: "font typography mono system queryLocalFonts" },
  { id: "advanced", label: "Advanced › Data & storage", keywords: "storage path data version diagnostics" },
  { id: "advanced", label: "Advanced › Settings management", keywords: "export import reset settings json" },
];

export default function SettingsPage(props: Props) {
  const [section, setSection] = useState<SettingsSectionId>(() => (localStorage.getItem("babylon:settings-section") as SettingsSectionId) || "models");
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [catalogue, setCatalogue] = useState<any[]>(props.models);
  const [levels, setLevels] = useState<string[]>(props.thinkingLevels);

  useEffect(() => { localStorage.setItem("babylon:settings-section", section); }, [section]);

  useEffect(() => {
    let cancelled = false;
    bridge.getSettings().then((s) => { if (!cancelled) setSettings(s); }).catch(() => undefined);
    if (!props.models.length) bridge.getModels().then((m) => { if (!cancelled && Array.isArray(m) && m.length) setCatalogue(m); }).catch(() => undefined);
    else setCatalogue(props.models);
    if (!props.thinkingLevels.length) bridge.getThinkingLevels().then((l) => { if (!cancelled && Array.isArray(l)) setLevels(l); }).catch(() => undefined);
    else setLevels(props.thinkingLevels);
    return () => { cancelled = true; };
  }, [props.models, props.thinkingLevels]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") {
        if (query) setQuery("");
        else props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, props]);

  const save = async (patch: Partial<PiSettings>) => {
    setSaveState("saving");
    setSaveError(null);
    try {
      const next = await bridge.setSettings(patch);
      setSettings(next);
      setSaveState("idle");
    } catch (e: any) {
      setSaveState("error");
      setSaveError(e?.message ?? "Failed to save");
    }
  };

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    return SEARCH_INDEX.filter((r) => {
      const hay = `${r.label} ${r.keywords}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [query]);

  return (
    <div ref={containerRef} className="flex h-full bg-bg" role="dialog" aria-label="Settings">
      <SettingsSidebar active={section} onSelect={setSection} onBack={props.onClose} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="settings-header flex h-[44px] shrink-0 items-center gap-3 px-8 sticky top-0 z-10">
          <h2 className="text-[13px] font-semibold tracking-[-0.015em] text-white shrink-0" style={{fontOpticalSizing:'auto'}}>Settings</h2>
          <div className="flex-1 flex justify-start">
            <div className="relative w-full max-w-[720px] ml-4">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim/60 text-[12px]">⌕</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                className="settings-input w-full pl-7 pr-7 py-1.5 text-[12.5px] placeholder:text-dim/60"
              />
              {query ? <button onClick={() => setQuery("")} aria-label="Clear search" className="settings-tab absolute right-2 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded-full bg-line/60 text-dim hover:text-fg hover:bg-line text-[11px]">×</button> : null}
            </div>
          </div>
        </header>

        {query ? (
          <div className="flex-1 overflow-auto p-4 settings-content" key="search">
            {results.length ? (
              <ul className="space-y-1 max-w-[720px]">
                {results.map((r) => (
                  <li key={r.label}>
                    <button onClick={() => { setSection(r.id); setQuery(""); }} className="settings-tab w-full text-left rounded-lg px-3 py-2.5 hover:bg-inset border border-transparent hover:border-line/30">
                      <span className="text-[13px] font-[550] tracking-[-0.01em]">{r.label}</span>
                      <span className="block text-[11.5px] leading-4 text-dim mt-0.5">{r.keywords.slice(0, 80)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] leading-5 text-dim text-center py-12">No settings found for “{query}”.</p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto bg-bg" style={{scrollbarGutter:'stable'}}>
            <div className="w-full max-w-[1120px] px-8 pt-8 pb-6 settings-content" key={section}>
              {!settings ? <p className="text-[12px] text-dim">Loading settings…</p> : (
                <>
                  {section === "models" && <SettingsModels models={catalogue} thinkingLevels={levels} agentState={props.agentState} settings={settings} onSave={save} onSetModel={props.onSetModel} onSetThinking={props.onSetThinking} saveError={saveError} />}
                  {section === "context" && <SettingsContext models={catalogue} agentState={props.agentState} settings={settings} onSave={save} />}
                  {section === "permissions" && <SettingsPermissions />}
                  {section === "git" && <SettingsGit settings={settings} onSave={save} models={catalogue} />}
                  {section === "background" && <SettingsBackground settings={settings} onSave={save} />}
                  {section === "appearance" && <SettingsAppearance settings={settings} onSave={save} theme={props.theme} onThemeChange={props.onThemeChange} />}
                  {section === "advanced" && <SettingsAdvanced settings={settings} onSave={save} />}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
