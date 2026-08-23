import { useEffect, useMemo, useState } from "react";
import { bridge, type ModelRef, type PiSettings } from "../bridge";
import { applyTheme, type ThemePref } from "../lib/theme";
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

                <Section title="Commit and push" hint="Runs a bounded write subagent that inspects the diff, commits, and pushes. Babylon always applies its built-in Unslop rules with low reasoning.">
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
                  <p className="mt-1.5 text-[11.5px] text-dim">These instructions are appended to the fixed Git safety and Unslop task.</p>
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
            )}
          </div>
      </div>
    </div>
  );
}
