import { useEffect, useState } from "react";
import type { DefaultBotPatch } from "../bots";
import { botHandle } from "../bots";
import type { ProjectSettings } from "../bridge";
import type { Bot, NewBotInput } from "../bots";
import { BotAvatar } from "./BotsPanel";

const inputCls = "w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px]";
const labelCls = "mb-1 block text-[12px] font-semibold text-dim";

/** Per-project settings: default-bot copy, staffed team, free-speak.
 *  Edits touch this project only, snapshots never propagate. */
export default function ProjectPanel({
  projectPath,
  settings,
  hash,
  employees,
  onSaveDefault,
  onResetDefault,
  onSetMembers,
  onSetFreeSpeak,
  onCreateAndStaff,
  onChanged,
  onClose,
}: {
  projectPath: string;
  settings: ProjectSettings;
  hash: string;
  employees: Bot[];
  onSaveDefault(patch: DefaultBotPatch): Promise<ProjectSettings>;
  onResetDefault(): Promise<ProjectSettings>;
  onSetMembers(ids: string[]): Promise<ProjectSettings>;
  onSetFreeSpeak(on: boolean): Promise<ProjectSettings>;
  onCreateAndStaff(input: NewBotInput): Promise<void>;
  onChanged(next: ProjectSettings): void;
  onClose(): void;
}) {
  const def = settings.defaultBot;
  const [name, setName] = useState(def.name);
  const [title, setTitle] = useState(def.title ?? "");
  const [persona, setPersona] = useState(def.persona ?? "");
  const [provider, setProvider] = useState(def.model?.provider ?? "");
  const [modelId, setModelId] = useState(def.model?.modelId ?? "");
  const [newName, setNewName] = useState("");
  const [newPersona, setNewPersona] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(def.name);
    setTitle(def.title ?? "");
    setPersona(def.persona ?? "");
    setProvider(def.model?.provider ?? "");
    setModelId(def.model?.modelId ?? "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, JSON.stringify(def)]);
  const staffed = new Set(settings.memberIds);
  const run = async (fn: () => Promise<ProjectSettings | void>, done?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      // Settings-returning ops sync the panel; void ops (hire) refresh via App state.
      if (result && typeof result === "object" && "defaultBot" in result) {
        onChanged(result as ProjectSettings);
      }
      done?.();
    } catch (e: any) {
      setError(e?.message ?? "Could not save project settings");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Project settings">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[88vh] w-[600px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">Project</h2>
          <span className="truncate font-mono text-[12px] text-dim" title={projectPath}>{projectPath}</span>
          <button type="button" onClick={onClose} aria-label="Close project settings" className="thread-action ml-auto">✕</button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3">
          <section>
            <p className="text-[13px] font-semibold">Default bot</p>
            <p className="mt-0.5 text-[12px] leading-5 text-dim">This project's copy. Changes stay here, new projects snapshot the app default.</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block"><span className={labelCls}>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} className={inputCls} /></label>
              <label className="block"><span className={labelCls}>Title</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} className={inputCls} /></label>
            </div>
            <label className="mt-2 block"><span className={labelCls}>Persona</span>
              <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={4} placeholder="Empty persona chats like today's default." className={`${inputCls} font-mono text-[12px]`} /></label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block"><span className={labelCls}>Model provider</span>
                <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="inherits global" className={inputCls} /></label>
              <label className="block"><span className={labelCls}>Model id</span>
                <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="inherits global" className={inputCls} /></label>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => {
                    const model = provider.trim() && modelId.trim() ? { provider: provider.trim(), modelId: modelId.trim() } : undefined;
                    // Clearing the model means inheriting global: send explicit null through.
                    return onSaveDefault({
                      name: name.trim(),
                      title: title.trim(),
                      persona: persona.trim(),
                      ...(model ? { model } : { model: undefined }),
                    } as DefaultBotPatch);
                  })
                }
                className="context-button is-primary"
              >
                {busy ? "Saving…" : "Save default"}
              </button>
              <button type="button" disabled={busy} onClick={() => void run(() => onResetDefault())} title="Replace this copy with a fresh snapshot of the app default" className="context-button">
                Reset to app default
              </button>
            </div>
          </section>
          <section>
            <p className="text-[13px] font-semibold">Team</p>
            <p className="mt-0.5 text-[12px] leading-5 text-dim">Staffed teammates stay silent unless @-mentioned, unless free discussion is on.</p>
            <div className="mt-2">
              {employees.filter((b) => !b.hidden).length === 0 ? (
                <p className="text-[12.5px] text-dim">No employees yet, create the first below.</p>
              ) : (
                employees.filter((b) => !b.hidden).map((b) => (
                  <label key={b.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-raised">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={staffed.has(b.id)}
                      onChange={() =>
                        void run(() =>
                          onSetMembers(staffed.has(b.id) ? settings.memberIds.filter((id) => id !== b.id) : [...settings.memberIds, b.id])
                        )
                      }
                    />
                    <BotAvatar name={b.name} size={18} />
                    <span className="text-[13px] font-semibold">@{botHandle(b)}</span>
                    {b.title ? <span className="truncate text-[12px] text-dim">{b.title}</span> : null}
                  </label>
                ))
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New teammate name" maxLength={48} aria-label="New teammate name" className={`${inputCls} flex-1`} />
              <input value={newPersona} onChange={(e) => setNewPersona(e.target.value)} placeholder="Persona (optional)" aria-label="New teammate persona" className={`${inputCls} flex-[2]`} />
              <button
                type="button"
                disabled={busy || !newName.trim()}
                onClick={() =>
                  void run(() => onCreateAndStaff({ name: newName.trim(), ...(newPersona.trim() ? { persona: newPersona.trim() } : {}) }), () => {
                    setNewName("");
                    setNewPersona("");
                  })
                }
                className="context-button shrink-0"
              >
                Hire
              </button>
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-line bg-raised px-2.5 py-2">
              <input
                type="checkbox"
                disabled={busy}
                checked={settings.freeSpeak}
                onChange={() => void run(() => onSetFreeSpeak(!settings.freeSpeak))}
                className="mt-0.5"
              />
              <span>
                <span className="block text-[13px] font-semibold">Free discussion</span>
                <span className="block text-[12px] leading-5 text-dim">Teammates may chime in unmentioned (full rotation, existing round caps). Off = mention-only.</span>
              </span>
            </label>
          </section>
          {error ? <p role="alert" className="text-[12.5px] text-err">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
