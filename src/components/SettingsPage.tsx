import { useEffect, useMemo, useState } from "react";
import { bridge, type ModelRef, type PiSettings } from "../bridge";
import { applyMonoFont, applySystemFonts, applyTheme, monoStack, MONO_FONTS, type ThemePref } from "../lib/theme";
import ModelPicker from "./ModelPicker";
import ThinkingPicker from "./ThinkingPicker";
import PermissionRulesSection from "./PermissionRulesSection";

interface Props {
  models: any[];
  thinkingLevels: string[];
  /** Live session state — the chat section mirrors and drives it. */
  agentState: any | null;
  onSetModel(provider: string, modelId: string): void;
  onSetThinking(level: string): void;
  theme: ThemePref;
  onThemeChange(theme: ThemePref): void;
  onClose(): void;
}

const fmtWin = (n?: number) => (n ? `${Math.round(n / 1000)}k` : "—");
const TABS = ["Pi", "Permissions", "Appearance"] as const;
type Tab = (typeof TABS)[number];

function Section(props: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3 className="settings-section-title">{props.title}</h3>
      {props.hint ? <p className="settings-section-hint">{props.hint}</p> : null}
      {props.children}
    </section>
  );
}

export default function SettingsPage(props: Props) {
  const [tab, setTab] = useState<Tab>("Pi");
  const [settings, setSettings] = useState<PiSettings | null>(null);
  // Local edit buffers are committed on blur instead of writing on each key.
  const [ctxDraft, setCtxDraft] = useState<Record<string, string>>({});
  const [gitPromptDraft, setGitPromptDraft] = useState("");
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontFilter, setFontFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    void bridge
      .getSettings()
      .then((s) => {
        if (!cancelled) {
          setSettings(s);
          setGitPromptDraft(s.gitCommitPrompt ?? "");
        }
      })
      .catch(() => undefined);
    void (async () => {
      // Prefer Local Font Access API (renderer, no asar/binary issues) — falls back to main-process enumeration.
      let fonts: string[] = [];
      try {
        if ("queryLocalFonts" in window) {
          const localFonts: Array<{ family: string }> = await (window as any).queryLocalFonts();
          fonts = [...new Set(localFonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
        }
      } catch {}
      if (!fonts.length) {
        try {
          const fromMain = await bridge.listFonts();
          if (Array.isArray(fromMain) && fromMain.length) fonts = fromMain;
        } catch {}
      }
      if (!cancelled) {
        if (fonts.length) setSystemFonts(fonts);
        else setSystemFonts(MONO_FONTS.map((f) => f.id));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Partial<PiSettings>) => {
    try {
      setSettings(await bridge.setSettings(patch));
    } catch {
      // Settings persistence is best-effort in the UI; the host caches too.
    }
  };

  // Chat model/reasoning drive the live session AND persist as the remembered default.
  const chatModel = props.agentState?.model ?? null;
  const chatReasoning = props.agentState?.thinkingLevel ?? settings?.chatReasoning ?? "off";

  const titleModel = useMemo(() => {
    const ref = settings?.titleModel;
    if (!ref) return null;
    return props.models.find((m) => m.provider === ref.provider && m.id === ref.modelId) ?? { provider: ref.provider, id: ref.modelId };
  }, [settings?.titleModel, props.models]);

  const gitCommitModel = useMemo(() => {
    const ref = settings?.gitCommitModel;
    if (!ref) return null;
    return props.models.find((m) => m.provider === ref.provider && m.id === ref.modelId) ?? { provider: ref.provider, id: ref.modelId };
  }, [settings?.gitCommitModel, props.models]);

  const overrides = settings?.contextWindowOverrides ?? {};

  const commitContextWindow = (provider: string, modelId: string, raw: string) => {
    const key = `${provider}/${modelId}`;
    const next = { ...overrides };
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) delete next[key];
    else next[key] = Math.round(n);
    setCtxDraft((d) => ({ ...d, [key]: raw }));
    void save({ contextWindowOverrides: next });
  };

  const pickTitleModel = (provider: string, modelId: string) => {
    const ref: ModelRef = { provider, modelId };
    void save({ titleModel: ref });
  };

  return (
    <div className="flex h-full" role="dialog" aria-label="Settings">
      <nav className="settings-rail flex w-[180px] shrink-0 flex-col gap-0.5 border-r border-line/60 p-2 pt-12" aria-label="Settings sections">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-left text-[13px] transition-colors duration-100 ${
              tab === t ? "font-medium text-accent" : "text-dim hover:text-fg"
            }`}
          >
            {t}
          </button>
        ))}
        <div className="mt-auto">
          <button onClick={props.onClose} className="w-full rounded-md px-3 py-1.5 text-left text-[13px] text-dim transition-colors duration-100 hover:text-fg">
            ← Back
          </button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line/60 px-5">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Settings</h2>
          <span className="text-[11px] text-dim">esc to close</span>
        </header>

        <div className="mx-auto w-full max-w-[720px] min-h-0 flex-1 overflow-y-auto p-6">
            {tab === "Pi" && (
              <>
                <Section title="Chat" hint="Applies to the live session immediately and is remembered as the default.">
                  <div className="flex items-center gap-2">
                    <ModelPicker
                      models={props.models}
                      current={chatModel}
                      disabled={!props.models.length}
                      onSelect={(p, id) => {
                        props.onSetModel(p, id);
                        void save({ chatModel: { provider: p, modelId: id } });
                      }}
                    />
                    <ThinkingPicker
                      current={chatReasoning}
                      available={props.thinkingLevels}
                      disabled={!props.agentState}
                      onSelect={(level) => {
                        props.onSetThinking(level);
                        void save({ chatReasoning: level });
                      }}
                    />
                  </div>
                  {!props.models.length && <p className="mt-2 text-[12px] text-dim">No models available — open a session to load the catalogue.</p>}
                </Section>

                <Section title="Title generation" hint="Used for automatic session names and recaps. Falls back to a built-in cheap model when unset.">
                  <div className="flex items-center gap-2">
                    <ModelPicker
                      models={props.models}
                      current={titleModel}
                      disabled={!props.models.length}
                      onSelect={pickTitleModel}
                    />
                    <ThinkingPicker
                      current={settings?.titleReasoning ?? "low"}
                      disabled={!settings}
                      onSelect={(level) => void save({ titleReasoning: level })}
                    />
                  </div>
                  {!settings && <p className="mt-2 text-[12px] text-dim">Loading settings…</p>}
                </Section>

                <Section title="Commit and push" hint="Stages the current tree, generates a message from the staged diff, then commits and pushes. Babylon always applies its built-in Unslop rules with low reasoning.">
                  <div className="flex items-center gap-2">
                    <ModelPicker
                      models={props.models}
                      current={gitCommitModel}
                      disabled={!props.models.length || !settings}
                      onSelect={(provider, modelId) => void save({ gitCommitModel: { provider, modelId } })}
                    />
                    <span className="rounded-md bg-inset px-2.5 py-1.5 text-[12px] text-dim">Low reasoning</span>
                  </div>
                  <label className="mt-3 block text-[12px] text-dim" htmlFor="git-commit-prompt">Prompt</label>
                  <textarea
                    id="git-commit-prompt"
                    rows={4}
                    value={gitPromptDraft}
                    disabled={!settings}
                    onChange={(event) => setGitPromptDraft(event.target.value)}
                    onBlur={() => void save({ gitCommitPrompt: gitPromptDraft })}
                    className="settings-input mt-1 w-full resize-y font-mono text-[12px] leading-5"
                  />
                  <p className="mt-1.5 text-[11.5px] text-dim">These instructions are appended to the fixed structured-output and Unslop prompt.</p>
                </Section>

                <Section title="Context windows" hint="Override the advertised context window per model. Empty restores the default.">
                  {!props.models.length ? (
                    <p className="text-[12px] text-dim">No models available.</p>
                  ) : (
                    <table className="w-full settings-ctx-table">
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Default</th>
                          <th>Override</th>
                        </tr>
                      </thead>
                      <tbody>
                        {props.models.map((m) => {
                          const key = `${m.provider}/${m.id}`;
                          const value = ctxDraft[key] ?? (overrides[key] !== undefined ? String(overrides[key]) : "");
                          return (
                            <tr key={key}>
                              <td>
                                <span className="block truncate text-[13px]">{m.name ?? m.id}</span>
                                <span className="block truncate font-mono text-[11px] text-dim">{key}</span>
                              </td>
                              <td className="font-mono text-[12px] text-dim">{fmtWin(m.contextWindow)}</td>
                              <td>
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min={0}
                                  placeholder="—"
                                  value={value}
                                  onChange={(e) => setCtxDraft((d) => ({ ...d, [key]: e.target.value }))}
                                  onBlur={(e) => commitContextWindow(m.provider, m.id, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                  }}
                                  className="settings-input w-[110px]"
                                  aria-label={`Context window override for ${key}`}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </Section>
              </>
            )}

            {tab === "Permissions" && (
              <Section title="Permission rules">
                <PermissionRulesSection />
              </Section>
            )}

            {tab === "Appearance" && (
              <>
                <Section title="Theme">
                  <div className="flex flex-col gap-0.5">
                    {( ["light", "dark", "system"] as ThemePref[] ).map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          applyTheme(t);
                          props.onThemeChange(t);
                        }}
                        className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-[13px] transition-colors duration-100 ${
                          props.theme === t ? "bg-inset text-fg" : "text-dim hover:text-fg"
                        }`}
                      >
                        <span className="capitalize">{t}</span>
                        {props.theme === t && <span className="text-accent">✓</span>}
                      </button>
                    ))}
                  </div>
                </Section>
                <Section title="Fonts" hint="Pick any font installed on this Mac — no font files are shipped. Inline code falls back to ui-monospace / SFMono-Regular if the family is missing.">
                  <div className="flex flex-col gap-3">
                    <label className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-inset">
                      <span className="text-[13px] text-fg">Use system fonts</span>
                      <input
                        type="checkbox"
                        checked={settings?.appearance?.useSystemFonts ?? true}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          applySystemFonts(enabled);
                          localStorage.setItem("pideck:useSystemFonts", String(enabled));
                          void save({ appearance: { ...(settings?.appearance ?? {}), useSystemFonts: enabled } });
                        }}
                        className="h-4 w-4 accent-accent"
                      />
                    </label>
                    <div>
                      <label className="block text-[12px] font-medium text-dim" htmlFor="font-filter">Font family</label>
                      <input
                        id="font-filter"
                        type="text"
                        placeholder="Filter fonts… (e.g. Helvetica)"
                        value={fontFilter}
                        onChange={(e) => setFontFilter(e.target.value)}
                        className="settings-input mt-1 w-full"
                      />
                      <select
                        id="mono-font"
                        value={settings?.appearance?.monoFontFamily ?? "system"}
                        onChange={(e) => {
                          const family = e.target.value;
                          applyMonoFont(family);
                          void save({ appearance: { ...(settings?.appearance ?? {}), monoFontFamily: family, useSystemFonts: true } });
                        }}
                        className="settings-input mt-1 w-full"
                        size={8}
                        style={{ fontFamily: monoStack(settings?.appearance?.monoFontFamily ?? "system") }}
                      >
                        <option value="system" style={{ fontFamily: monoStack("system") }}>System Default — ui-monospace</option>
                        {(systemFonts.length ? systemFonts : MONO_FONTS.map((f) => f.id))
                          .filter((f) => !fontFilter.trim() || f.toLowerCase().includes(fontFilter.trim().toLowerCase()))
                          .slice(0, 400)
                          .map((f) => (
                            <option key={f} value={f} style={{ fontFamily: monoStack(f) }}>{f}</option>
                          ))}
                      </select>
                      <p className="mt-1 text-[11px] text-dim">{systemFonts.length ? `${systemFonts.length} system fonts found` : "Loading system fonts…"} {fontFilter ? `· ${systemFonts.filter((f) => f.toLowerCase().includes(fontFilter.toLowerCase())).length} matched` : ""}</p>
                      <div className="mt-2 rounded-md border border-line bg-inset/40 px-3 py-2">
                        <p className="text-[11px] font-medium text-dim">Preview — {settings?.appearance?.monoFontFamily ?? "system"}</p>
                        <p className="mt-1 truncate text-[13px]" style={{ fontFamily: monoStack(settings?.appearance?.monoFontFamily ?? "system") }}>{`const answer = 42 // ${settings?.appearance?.monoFontFamily ?? "system"}`}</p>
                        <p className="truncate text-[13px]" style={{ fontFamily: monoStack(settings?.appearance?.monoFontFamily ?? "system") }}>The quick brown fox jumps over 0123456789</p>
                        <p className="truncate text-[12px] text-dim" style={{ fontFamily: monoStack(settings?.appearance?.monoFontFamily ?? "system") }}>git commit -m "feat: ship any system font"</p>
                      </div>
                    </div>
                  </div>
                </Section>
              </>
            )}
          </div>
      </div>
    </div>
  );
}
