import { useMemo, useState } from "react";
import { Checkbox } from "./ui/Checkbox";
import { BotAvatar } from "./BotAvatar";
import type { DefaultBot } from "../bots";
import {
  botHandle,
  validateNewBot,
  validateNewGroup,
  type Bot,
  type BotGroup,
  type BotPatch,
  type NewBotInput,
  type NewGroupInput,
} from "../bots";

interface BotFormState {
  name: string;
  title: string;
  description: string;
  persona: string;
  modelProvider: string;
  modelId: string;
  cwd: string;
}

function formFromBot(bot?: Bot): BotFormState {
  return {
    name: bot?.name ?? "",
    title: bot?.title ?? "",
    description: bot?.description ?? "",
    persona: bot?.persona ?? "",
    modelProvider: bot?.model?.provider ?? "",
    modelId: bot?.model?.modelId ?? "",
    cwd: bot?.cwd ?? "",
  };
}

function formToInput(form: BotFormState): NewBotInput {
  return {
    name: form.name,
    ...(form.title.trim() ? { title: form.title.trim() } : {}),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.persona.trim() ? { persona: form.persona.trim() } : {}),
    ...(form.modelProvider.trim() && form.modelId.trim()
      ? { model: { provider: form.modelProvider.trim(), modelId: form.modelId.trim() } }
      : {}),
    ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
  };
}

function formToPatch(form: BotFormState, original: Bot): BotPatch {
  const patch: BotPatch = {};
  if (form.name.trim() !== original.name) patch.name = form.name.trim();
  const title = form.title.trim() || undefined;
  if (title !== original.title) patch.title = title;
  const description = form.description.trim() || undefined;
  if (description !== original.description) patch.description = description;
  const persona = form.persona.trim() || undefined;
  if (persona !== original.persona) patch.persona = persona;
  const hasModel = form.modelProvider.trim() !== "" && form.modelId.trim() !== "";
  const model = hasModel ? { provider: form.modelProvider.trim(), modelId: form.modelId.trim() } : undefined;
  if (JSON.stringify(model ?? null) !== JSON.stringify(original.model ?? null)) patch.model = model;
  const cwd = form.cwd.trim() || undefined;
  if (cwd !== original.cwd) patch.cwd = cwd;
  return patch;
}

export interface BotsManagerProps {
  bots: Bot[];
  activeBotId: string | null;
  groups?: BotGroup[];
  activeGroupId?: string | null;
  defaultBot?: DefaultBot | null;
  onCreate(input: NewBotInput): Promise<void>;
  onUpdate(id: string, patch: BotPatch): Promise<void>;
  onDelete(bot: Bot): Promise<void>;
  onCreateGroup?(input: NewGroupInput): Promise<void>;
  onUpdateGroup?(id: string, patch: { name?: string; memberIds?: string[] }): Promise<void>;
  onDeleteGroup?(group: BotGroup): Promise<void>;
  onOpenGroup?(group: BotGroup): void | Promise<void>;
  onSaveDefaultBot?(input: DefaultBot): Promise<void>;
}

type Selection =
  | { kind: "empty" }
  | { kind: "default" }
  | { kind: "new" }
  | { kind: "bot"; id: string }
  | { kind: "newGroup" }
  | { kind: "group"; id: string };

/** Master-detail bot management. Not a modal: roster and editor live side by
 *  side so selecting a bot swaps the editor instead of stacking a dialog. */
export default function BotsManager({
  bots,
  activeBotId,
  groups = [],
  activeGroupId = null,
  defaultBot = null,
  onCreate,
  onUpdate,
  onDelete,
  onCreateGroup = async () => {},
  onUpdateGroup = async () => {},
  onDeleteGroup = async () => {},
  onOpenGroup,
  onSaveDefaultBot,
}: BotsManagerProps) {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>({ kind: "empty" });
  const [pending, setPending] = useState<Selection | null>(null);
  const [dirty, setDirty] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = [...bots].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return rows;
    return rows.filter(
      (b) => b.name.toLowerCase().includes(q) || (b.title ?? "").toLowerCase().includes(q) || botHandle(b).includes(q)
    );
  }, [bots, query]);
  const sortedGroups = useMemo(() => [...groups].sort((a, b) => a.name.localeCompare(b.name)), [groups]);
  const hiddenCount = bots.filter((b) => b.hidden).length;

  // Selecting while an editor is dirty asks before discarding, inline.
  const select = (next: Selection) => {
    setDirty(false);
    if (dirty) setPending(next);
    else setSelection(next);
  };
  const done = () => {
    setDirty(false);
    setPending(null);
    setSelection({ kind: "empty" });
  };

  const selectedBot = selection.kind === "bot" ? bots.find((b) => b.id === selection.id) ?? null : null;
  const selectedGroup = selection.kind === "group" ? groups.find((g) => g.id === selection.id) ?? null : null;

  return (
    <div className="grid h-[min(72vh,640px)] grid-cols-[300px_1fr] overflow-hidden rounded-[var(--radius-lg)] border border-line">
      {/* Roster */}
      <div className="flex min-h-0 flex-col border-r border-line">
        <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
          <span className="text-[13px] font-semibold">Bots</span>
          <span className="text-[12px] text-dim">
            {bots.length === 0 ? "none" : `${bots.length}`}
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
          </span>
          <button type="button" onClick={() => select({ kind: "new" })} className="ml-auto text-[12px] font-medium text-accent hover:underline">
            New bot
          </button>
        </div>
        <div className="shrink-0 px-3 pb-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter bots…"
            aria-label="Filter bots"
            className="w-full rounded-[var(--radius-sm)] border border-line bg-raised px-2 py-1.5 text-[13px] text-fg placeholder:text-dim"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {defaultBot ? (
            <RosterRow selected={selection.kind === "default"} onClick={() => select({ kind: "default" })}>
              <BotAvatar name={defaultBot.name} size={22} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">Default bot</span>
                <span className="block truncate text-[11px] text-dim">{defaultBot.name} · new projects</span>
              </span>
            </RosterRow>
          ) : null}

          <GroupLabel>Bots</GroupLabel>
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-[12px] leading-5 text-dim">
              {bots.length === 0 ? "No bots yet. Create one." : `No bots match "${query}".`}
            </p>
          ) : (
            visible.map((bot) => (
              <RosterRow key={bot.id} selected={selection.kind === "bot" && selection.id === bot.id} onClick={() => select({ kind: "bot", id: bot.id })}>
                <BotAvatar name={bot.name} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold">{bot.name}</span>
                    {bot.hidden ? <span className="text-[11px] text-dim">(hidden)</span> : null}
                    {bot.id === activeBotId ? <span className="text-[11px] font-semibold text-accent">●</span> : null}
                  </span>
                  <span className="block truncate text-[11px] text-dim">
                    {bot.title ?? `@${botHandle(bot)}`}
                    {bot.mainSessionFile ? " · has chat" : ""}
                  </span>
                </span>
              </RosterRow>
            ))
          )}

          <div className="mt-3 flex items-center gap-2 px-2 pb-1">
            <GroupLabel className="px-0">Rooms</GroupLabel>
            <button
              type="button"
              disabled={bots.filter((b) => !b.hidden).length < 2}
              onClick={() => select({ kind: "newGroup" })}
              className="ml-auto text-[12px] font-medium text-accent hover:underline disabled:opacity-40"
            >
              New room
            </button>
          </div>
          {sortedGroups.length === 0 ? (
            <p className="px-2 py-1 text-[11px] leading-5 text-dim">Rooms need 2+ bots.</p>
          ) : (
            sortedGroups.map((group) => (
              <RosterRow key={group.id} selected={selection.kind === "group" && selection.id === group.id} onClick={() => select({ kind: "group", id: group.id })}>
                <BotAvatar name={group.name} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold">{group.name}</span>
                    {group.id === activeGroupId ? <span className="text-[11px] font-semibold text-accent">●</span> : null}
                  </span>
                  <span className="block truncate text-[11px] text-dim">
                    {group.memberIds.map((id) => bots.find((b) => b.id === id)?.name ?? "?").join(", ")}
                  </span>
                </span>
              </RosterRow>
            ))
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="min-h-0 overflow-y-auto p-5">
        {pending ? (
          <div className="mb-4 flex items-center gap-3 rounded-[var(--radius-sm)] border border-line bg-inset px-3 py-2 text-[12px]">
            <span className="text-dim">Discard unsaved changes?</span>
            <button
              type="button"
              onClick={() => {
                const next = pending;
                setPending(null);
                setDirty(false);
                setSelection(next);
              }}
              className="ml-auto font-medium text-err hover:underline"
            >
              Discard
            </button>
            <button type="button" onClick={() => setPending(null)} className="text-dim hover:text-fg">
              Keep editing
            </button>
          </div>
        ) : null}
        {selection.kind === "empty" ? (
          <EmptyDetail hasBots={bots.length > 0} />
        ) : selection.kind === "default" ? (
          defaultBot && onSaveDefaultBot ? (
            <DefaultBotEditor key="default" initial={defaultBot} onSave={onSaveDefaultBot} onDirty={setDirty} />
          ) : (
            <EmptyDetail hasBots={bots.length > 0} />
          )
        ) : selection.kind === "new" ? (
          <BotEditor key="new" onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} onDone={done} onDirty={setDirty} />
        ) : selection.kind === "bot" && selectedBot ? (
          <BotEditor
            key={selectedBot.id}
            bot={selectedBot}
            onCreate={onCreate}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onDone={done}
            onDirty={setDirty}
          />
        ) : selection.kind === "newGroup" ? (
          <GroupEditor key="newGroup" bots={bots} onCreateGroup={onCreateGroup} onUpdateGroup={onUpdateGroup} onDeleteGroup={onDeleteGroup} onOpenGroup={onOpenGroup} onDone={done} onDirty={setDirty} />
        ) : selection.kind === "group" && selectedGroup ? (
          <GroupEditor
            key={selectedGroup.id}
            group={selectedGroup}
            bots={bots}
            onCreateGroup={onCreateGroup}
            onUpdateGroup={onUpdateGroup}
            onDeleteGroup={onDeleteGroup}
            onOpenGroup={onOpenGroup}
            onDone={done}
            onDirty={setDirty}
          />
        ) : (
          <EmptyDetail hasBots={bots.length > 0} />
        )}
      </div>
    </div>
  );
}

function GroupLabel({ children, className = "px-2" }: { children: React.ReactNode; className?: string }) {
  return <p className={`${className} pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-dim`}>{children}</p>;
}

function RosterRow({ selected, onClick, children }: { selected: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-2 text-left ${selected ? "bg-inset" : "hover:bg-inset"}`}
    >
      {children}
    </button>
  );
}

function EmptyDetail({ hasBots }: { hasBots: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-dim">
      <p className="text-[13px]">{hasBots ? "Select a bot or room to edit." : "No bots yet."}</p>
      <p className="text-[12px]">{hasBots ? "Or create a new bot." : "Create your first specialist."}</p>
    </div>
  );
}

const fieldLabel = "mb-1 block text-[12px] font-medium text-dim";
const inputCls = "w-full rounded-[var(--radius-sm)] border border-line bg-raised px-2 py-1.5 text-[13px]";

function BotEditor({
  bot,
  onCreate,
  onUpdate,
  onDelete,
  onDone,
  onDirty,
}: {
  bot?: Bot;
  onCreate(input: NewBotInput): Promise<void>;
  onUpdate(id: string, patch: BotPatch): Promise<void>;
  onDelete(bot: Bot): Promise<void>;
  onDone(): void;
  onDirty?(dirty: boolean): void;
}) {
  const isNew = !bot;
  const [form, setForm] = useState<BotFormState>(() => formFromBot(bot));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof BotFormState) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    onDirty?.(true);
  };
  const save = async () => {
    const input = formToInput(form);
    const check = validateNewBot(input);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (bot) {
        const patch = formToPatch(form, bot);
        if (Object.keys(patch).length > 0) await onUpdate(bot.id, patch);
      } else {
        await onCreate(input);
      }
      onDone();
    } catch (e: any) {
      setError(e?.message ?? "Could not save the bot");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-start gap-3">
        <BotAvatar name={form.name || "?"} size={32} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold">{isNew ? "New bot" : bot.name}</h3>
          <p className="truncate text-[12px] text-dim">
            {isNew ? "A specialist with its own forever-chat." : `@${botHandle(bot)}${bot.mainSessionFile ? " · has chat" : " · no chat yet"}`}
          </p>
        </div>
      </header>
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className={fieldLabel}>Name</span>
          <input value={form.name} onChange={(e) => set("name")(e.target.value)} placeholder="Reviewer" maxLength={48} className={inputCls} />
        </label>
        <label className="block">
          <span className={fieldLabel}>Title (role)</span>
          <input value={form.title} onChange={(e) => set("title")(e.target.value)} placeholder="Security reviewer" maxLength={80} className={inputCls} />
        </label>
        <label className="block">
          <span className={fieldLabel}>Description</span>
          <input value={form.description} onChange={(e) => set("description")(e.target.value)} placeholder="Reviews diffs for security issues before merge" maxLength={500} className={inputCls} />
        </label>
        <label className="block">
          <span className={fieldLabel}>Persona (standing instructions)</span>
          <textarea value={form.persona} onChange={(e) => set("persona")(e.target.value)} placeholder="Be terse. Always check auth boundaries first." rows={6} className={`${inputCls}`} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={fieldLabel}>Model provider</span>
            <input value={form.modelProvider} onChange={(e) => set("modelProvider")(e.target.value)} placeholder="inherits global" className={inputCls} />
          </label>
          <label className="block">
            <span className={fieldLabel}>Model id</span>
            <input value={form.modelId} onChange={(e) => set("modelId")(e.target.value)} placeholder="inherits global" className={inputCls} />
          </label>
        </div>
        <label className="block">
          <span className={fieldLabel}>Home project</span>
          <input value={form.cwd} onChange={(e) => set("cwd")(e.target.value)} placeholder="inherits current" className={`${inputCls}`} />
        </label>
        {error ? <p role="alert" className="text-[12px] text-err">{error}</p> : null}
      </div>
      <div className="mt-auto flex items-center gap-2 pt-5">
        {bot && onDelete ? (
          <button
            type="button"
            onClick={() => void onDelete(bot).then(onDone).catch((e: any) => setError(e?.message ?? "Could not delete the bot"))}
            className="text-[12px] text-err hover:underline"
          >
            Delete
          </button>
        ) : null}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onDone} className="context-button">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy} className="context-button is-primary">
            {busy ? "Saving…" : isNew ? "Create bot" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupEditor({
  group,
  bots,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onOpenGroup,
  onDone,
  onDirty,
}: {
  group?: BotGroup;
  bots: Bot[];
  onCreateGroup(input: NewGroupInput): Promise<void>;
  onUpdateGroup(id: string, patch: { name?: string; memberIds?: string[] }): Promise<void>;
  onDeleteGroup(group: BotGroup): Promise<void>;
  onOpenGroup?(group: BotGroup): void | Promise<void>;
  onDone(): void;
  onDirty?(dirty: boolean): void;
}) {
  const isNew = !group;
  const [name, setName] = useState(group?.name ?? "");
  const [members, setMembers] = useState<string[]>(group ? [...group.memberIds] : []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const candidates = bots.filter((b) => !b.hidden);
  const toggle = (id: string) => {
    setMembers((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    onDirty?.(true);
  };
  const save = async () => {
    const check = validateNewGroup({ name, memberIds: members });
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (group) await onUpdateGroup(group.id, { name: check.value.name, memberIds: check.value.memberIds });
      else await onCreateGroup({ name: check.value.name, memberIds: check.value.memberIds });
      onDone();
    } catch (e: any) {
      setError(e?.message ?? "Could not save the room");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-start gap-3">
        <BotAvatar name={name || "?"} size={32} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold">{isNew ? "New room" : group.name}</h3>
          <p className="text-[12px] text-dim">Members take serial turns in one shared room.</p>
        </div>
      </header>
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className={fieldLabel}>Name</span>
          <input value={name} onChange={(e) => { setName(e.target.value); onDirty?.(true); }} placeholder="Release crew" maxLength={48} className={inputCls} />
        </label>
        <fieldset className="block">
          <legend className={fieldLabel}>Members (2–6)</legend>
          {candidates.length === 0 ? (
            <p className="text-[12px] text-dim">Create bots first.</p>
          ) : (
            candidates.map((b) => (
              <label key={b.id} onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; toggle(b.id); }} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-inset">
                <Checkbox checked={members.includes(b.id)} onChange={() => toggle(b.id)} ariaLabel={b.name} />
                <BotAvatar name={b.name} size={18} />
                <span className="text-[13px]">{b.name}</span>
                {b.title ? <span className="truncate text-[12px] text-dim">{b.title}</span> : null}
              </label>
            ))
          )}
        </fieldset>
        {error ? <p role="alert" className="text-[12px] text-err">{error}</p> : null}
      </div>
      <div className="mt-auto flex items-center gap-2 pt-5">
        {group && onOpenGroup ? (
          <button
            type="button"
            onClick={() => void onOpenGroup(group)}
            className="text-[12px] font-medium text-accent hover:underline"
          >
            Open room
          </button>
        ) : null}
        {group && onDeleteGroup ? (
          <button
            type="button"
            onClick={() => void onDeleteGroup(group).then(onDone).catch((e: any) => setError(e?.message ?? "Could not delete the room"))}
            className="text-[12px] text-err hover:underline"
          >
            Delete
          </button>
        ) : null}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onDone} className="context-button">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy} className="context-button is-primary">
            {busy ? "Saving…" : isNew ? "Create room" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DefaultBotEditor({ initial, onSave, onDirty }: { initial: DefaultBot; onSave: (input: DefaultBot) => Promise<void>; onDirty?(dirty: boolean): void }) {
  const [name, setName] = useState(initial.name);
  const [title, setTitle] = useState(initial.title ?? "");
  const [persona, setPersona] = useState(initial.persona ?? "");
  const [provider, setProvider] = useState(initial.model?.provider ?? "");
  const [modelId, setModelId] = useState(initial.model?.modelId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty =
    name !== initial.name ||
    title !== (initial.title ?? "") ||
    persona !== (initial.persona ?? "") ||
    provider !== (initial.model?.provider ?? "") ||
    modelId !== (initial.model?.modelId ?? "");
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-start gap-3">
        <BotAvatar name={name || "?"} size={32} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold">Default bot</h3>
          <p className="text-[12px] leading-5 text-dim">Snapshotted into new projects. Existing projects keep their copy.</p>
        </div>
      </header>
      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={fieldLabel}>Name</span>
            <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); onDirty?.(true); }} maxLength={48} className={inputCls} />
          </label>
          <label className="block">
            <span className={fieldLabel}>Title</span>
            <input value={title} onChange={(e) => { setTitle(e.target.value); setSaved(false); onDirty?.(true); }} maxLength={80} className={inputCls} />
          </label>
        </div>
        <label className="block">
          <span className={fieldLabel}>Persona</span>
          <textarea value={persona} onChange={(e) => { setPersona(e.target.value); setSaved(false); onDirty?.(true); }} rows={6} placeholder="Empty persona chats like today's default." className={`${inputCls}`} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={fieldLabel}>Model provider</span>
            <input value={provider} onChange={(e) => { setProvider(e.target.value); setSaved(false); onDirty?.(true); }} placeholder="inherits global" className={inputCls} />
          </label>
          <label className="block">
            <span className={fieldLabel}>Model id</span>
            <input value={modelId} onChange={(e) => { setModelId(e.target.value); setSaved(false); onDirty?.(true); }} placeholder="inherits global" className={inputCls} />
          </label>
        </div>
        {error ? <p role="alert" className="text-[12px] text-err">{error}</p> : null}
      </div>
      <div className="mt-auto flex items-center gap-2 pt-5">
        {saved && !dirty ? <span className="text-[12px] text-ok">Saved</span> : null}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setError(null);
                try {
                  const model = provider.trim() && modelId.trim() ? { provider: provider.trim(), modelId: modelId.trim() } : undefined;
                  await onSave({
                    name: name.trim(),
                    ...(title.trim() ? { title: title.trim() } : {}),
                    ...(persona.trim() ? { persona: persona.trim() } : {}),
                    ...(model ? { model } : {}),
                  });
                  setSaved(true);
                } catch (e: any) {
                  setError(e?.message ?? "Could not save the default bot");
                } finally {
                  setBusy(false);
                }
              })()
            }
            className="context-button is-primary"
          >
            {busy ? "Saving…" : "Save default"}
          </button>
        </div>
      </div>
    </div>
  );
}
