import { useEffect, useMemo, useRef, useState } from "react";
import { bridge, type PiSettings } from "../bridge";
import type { ThemeId, ThemePref } from "../lib/theme";
import { SettingsSidebar, type SettingsSectionId } from "./settings/SettingsSidebar";
import { SettingsModels } from "./settings/SettingsModels";
import { SettingsContext } from "./settings/SettingsContext";
import { SettingsPermissions } from "./settings/SettingsPermissions";
import { SettingsGit } from "./settings/SettingsGit";
import { SettingsBackground } from "./settings/SettingsBackground";
import { SettingsAppearance } from "./settings/SettingsAppearance";
import { SettingsAdvanced } from "./settings/SettingsAdvanced";
import { SettingsBots } from "./settings/SettingsBots";
import type { BotsManagerProps } from "./BotsManager";
import { errorMessage } from "../lib/errors";
import type { AgentModel, AgentState } from "../bridge";

interface Props {
  models: AgentModel[];
  agentState: AgentState | null;
  theme: ThemePref;
  onThemeChange(theme: ThemePref): void;
  themeId: ThemeId;
  onThemeIdChange(id: ThemeId): void;
  onClose(): void;
  botsManager: BotsManagerProps;
}

type SEARCH_ENTRY = { id: SettingsSectionId; label: string; keywords: string };
const SEARCH_INDEX: Array<SEARCH_ENTRY> = [
  { id: "models", label: "Models › Default chat model", keywords: "model provider reasoning chat default current session" },
  { id: "bots", label: "Bots › Team", keywords: "bot specialist roster team default staff teammates chat manager" },
  { id: "models", label: "Models › Title generation", keywords: "title recap model reasoning" },
  { id: "models", label: "Models › Image model", keywords: "image model vision screenshot diagram attachment describe read" },
  { id: "models", label: "Models › Model catalogue", keywords: "catalogue list provider context window vision image" },
  { id: "context", label: "Context › Compaction", keywords: "compaction summary automatic snapcompact experimental vision fallback strategy" },
  { id: "context", label: "Context › Context window overrides", keywords: "context window override expert provider" },
  { id: "permissions", label: "Permissions › Rules", keywords: "permission rule allow deny policy mode" },
  { id: "git", label: "Git › Commit generation", keywords: "git commit prompt unslop message generation" },
  { id: "background", label: "Background › Daemon", keywords: "daemon background runtime keep enabled" },
  { id: "appearance", label: "Appearance › Theme", keywords: "theme light dark system appearance" },
  { id: "appearance", label: "Appearance › Typography", keywords: "font typography mono system queryLocalFonts" },
  { id: "appearance", label: "Appearance › Chat text size", keywords: "font size text conversation chat scale smaller larger readability" },
  { id: "advanced", label: "Advanced › Data & storage", keywords: "storage path data version diagnostics" },
  { id: "advanced", label: "Advanced › Settings management", keywords: "export import reset settings json" },
];

export default function SettingsPage(props: Props) {
  const [section, setSection] = useState<SettingsSectionId>(() => (localStorage.getItem("babylon:settings-section") as SettingsSectionId) || "models");
  const [settings, setSettings] = useState<PiSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [catalogue, setCatalogue] = useState<AgentModel[]>(props.models);

  useEffect(() => { localStorage.setItem("babylon:settings-section", section); }, [section]);

  useEffect(() => {
    let cancelled = false;
    bridge.getSettings().then((s) => { if (!cancelled) setSettings(s); }).catch(() => undefined);
    if (!props.models.length) bridge.getModels().then((m) => { if (!cancelled && Array.isArray(m) && m.length) setCatalogue(m); }).catch(() => undefined);
    else setCatalogue(props.models);
    return () => { cancelled = true; };
  }, [props.models]);

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
    setSaveError(null);
    try {
      const next = await bridge.setSettings(patch);
      setSettings(next);
    } catch (e) {
      setSaveError(errorMessage(e, "Failed to save"));
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
    <div className="absolute inset-0 z-[80] flex h-full bg-bg" role="dialog" aria-label="Settings">
      <SettingsSidebar active={section} onSelect={setSection} onBack={props.onClose} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="settings-header flex h-[44px] shrink-0 items-center gap-3 px-8 sticky top-0 z-10">
          <h2 className="text-[13px] font-semibold tracking-[-0.015em] text-fg shrink-0" style={{fontOpticalSizing:'auto'}}>Settings</h2>
          <div className="flex-1 flex justify-start">
            <div className="relative w-full max-w-[720px] ml-4">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim/60 text-[12px]">⌕</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                className="settings-input w-full pl-7 pr-7 py-1.5 text-[13px] placeholder:text-dim"
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
                    <button onClick={() => { setSection(r.id); setQuery(""); }} className="settings-tab w-full text-left rounded-[var(--radius)] px-3 py-2.5 hover:bg-inset border border-transparent hover:border-line/30">
                      <span className="text-[13px] font-[550] tracking-[-0.01em]">{r.label}</span>
                      <span className="block text-[12px] leading-4 text-dim mt-0.5">{r.keywords.slice(0, 80)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] leading-5 text-dim text-center py-12">No settings found for "{query}".</p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto bg-bg" style={{scrollbarGutter:'stable'}}>
            <div className="w-full max-w-[1120px] px-8 pt-6 pb-6 settings-content" key={section}>
              {!settings ? <p className="text-[12px] text-dim">Loading settings…</p> : (
                <>
                  {saveError ? <p className="mb-4 rounded-[var(--radius-sm)] border border-err/20 bg-err/5 px-3 py-2 text-[13px] text-err">{saveError}</p> : null}
                  {section === "models" && <SettingsModels models={catalogue} agentState={props.agentState} settings={settings} onSave={save} />}
                  {section === "context" && <SettingsContext models={catalogue} agentState={props.agentState} settings={settings} onSave={save} />}
                  {section === "permissions" && <SettingsPermissions />}
                  {section === "bots" && <SettingsBots manager={props.botsManager} />}
                  {section === "git" && <SettingsGit settings={settings} onSave={save} models={catalogue} />}
                  {section === "background" && <SettingsBackground settings={settings} onSave={save} />}
                  {section === "appearance" && <SettingsAppearance settings={settings} onSave={save} theme={props.theme} onThemeChange={props.onThemeChange} themeId={props.themeId} onThemeIdChange={props.onThemeIdChange} />}
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
