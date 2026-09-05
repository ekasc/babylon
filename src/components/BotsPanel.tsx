import { useMemo, useState } from "react";
import type { DefaultBot } from "../bots";
import {
  botAvatarHue,
  botHandle,
  botInitials,
  validateNewBot,
  validateNewGroup,
  type Bot,
  type BotGroup,
  type BotPatch,
  type NewBotInput,
  type NewGroupInput,
} from "../bots";

export function BotAvatar({ name, size = 22 }: { name: string; size?: number }) {
  const hue = botAvatarHue(name);
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.42)),
        backgroundColor: `hsl(${hue} 55% 42%)`,
      }}
    >
      {botInitials(name)}
    </span>
  );
}

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

export default function BotsPanel({
  bots,
  activeBotId,
  onOpen,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
  groups = [],
  activeGroupId = null,
  onOpenGroup = () => {},
  onCreateGroup = async () => {},
  onUpdateGroup = async () => {},
  onDeleteGroup = async () => {},
  onSendMessage = async () => {},
  defaultBot = null,
  onSaveDefaultBot,
}: {
  bots: Bot[];
  activeBotId: string | null;
  onOpen(bot: Bot): void;
  onCreate(input: NewBotInput): Promise<void>;
  onUpdate(id: string, patch: BotPatch): Promise<void>;
  onDelete(bot: Bot): Promise<void>;
  onClose(): void;
  groups?: BotGroup[];
  activeGroupId?: string | null;
  onOpenGroup?(group: BotGroup): void;
  onCreateGroup?(input: NewGroupInput): Promise<void>;
  onUpdateGroup?(id: string, patch: { name?: string; memberIds?: string[] }): Promise<void>;
  onDeleteGroup?(group: BotGroup): Promise<void>;
  onSendMessage?(targetId: string, text: string): Promise<void>;
  /** App-default template (null = not loaded). Snapshotted into new projects. */
  defaultBot?: DefaultBot | null;
  onSaveDefaultBot?(input: DefaultBot): Promise<void>;
}) {
  const [dialog, setDialog] = useState<{ mode: "new" } | { mode: "edit"; bot: Bot } | null>(null);
  const [form, setForm] = useState<BotFormState>(formFromBot());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [groupDialog, setGroupDialog] = useState<{ mode: "new" } | { mode: "edit"; group: BotGroup } | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [dmTarget, setDmTarget] = useState<Bot | null>(null);
  const [dmText, setDmText] = useState("");
  const [dmError, setDmError] = useState<string | null>(null);
  const [dmBusy, setDmBusy] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = [...bots].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return rows;
    return rows.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        botHandle(b).includes(q)
    );
  }, [bots, query]);
  const hiddenCount = bots.filter((b) => b.hidden).length;

  const openDialog = (next: { mode: "new" } | { mode: "edit"; bot: Bot }) => {
    setDialog(next);
    setForm(formFromBot(next.mode === "edit" ? next.bot : undefined));
    setError(null);
  };

  const save = async () => {
    const input = formToInput(form);
    const check = validateNewBot(input);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    try {
      if (dialog?.mode === "edit") {
        const patch = formToPatch(form, dialog.bot);
        if (Object.keys(patch).length > 0) await onUpdate(dialog.bot.id, patch);
      } else {
        await onCreate(input);
      }
      setDialog(null);
    } catch (e: any) {
      setError(e?.message ?? "Could not save the bot");
    } finally {
      setBusy(false);
    }
  };

  const set = (key: keyof BotFormState) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Overlay tiers: popovers and panel modals at z-50, Bots modal at z-60,
  // global transients (palette, confirm prompts, toasts) at z-70. Keeps
  // background picker popovers under this modal while confirms still surface.
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Bots">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[88vh] min-h-[min(600px,80vh)] w-[720px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">Bots</h2>
          <span className="text-[12px] text-dim">
            {bots.length === 0 ? "no specialists yet" : `${bots.length} specialist${bots.length === 1 ? "" : "s"}`}
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
          </span>
          <button type="button" onClick={() => openDialog({ mode: "new" })} className="context-button ml-auto">
            New bot
          </button>
          <button type="button" onClick={onClose} aria-label="Close bots" className="thread-action">
            ✕
          </button>
        </div>

        <div className="shrink-0 border-b border-line px-4 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter bots…"
            aria-label="Filter bots"
            className="w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px] text-fg placeholder:text-dim"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {onSaveDefaultBot && defaultBot ? (
            <DefaultBotSection key={JSON.stringify(defaultBot)} initial={defaultBot} onSave={onSaveDefaultBot} />
          ) : null}
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] leading-6 text-dim">
              {bots.length === 0 ? (
                <>No bots yet. Create a specialist, a reviewer, a researcher, a release captain, with its own persona, model, and forever-chat.</>
              ) : (
                <>No bots match "{query}".</>
              )}
            </p>
          ) : (
            visible.map((bot) => (
              <div
                key={bot.id}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 ${bot.id === activeBotId ? "bg-accent/10" : "hover:bg-raised"}`}
              >
                <button
                  type="button"
                  onClick={() => { onOpen(bot); onClose(); }}
                  title={bot.description ?? `Open ${bot.name}'s chat`}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <BotAvatar name={bot.name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold">{bot.name}</span>
                      {bot.hidden ? <span className="text-[11px] text-dim">(hidden)</span> : null}
                      {bot.id === activeBotId ? <span className="text-[11px] font-semibold text-accent">● open</span> : null}
                    </span>
                    <span className="block truncate text-[12px] text-dim">
                      {bot.title ?? `@${botHandle(bot)}`}
                      {bot.model ? ` · ${bot.model.provider}/${bot.model.modelId}` : ""}
                      {bot.mainSessionFile ? " · has chat" : " · no chat yet"}
                    </span>
                  </span>
                </button>
                <button type="button" title={`Edit ${bot.name}`} onClick={() => openDialog({ mode: "edit", bot })} className="thread-action thread-action-text text-[12px]">
                  Edit
                </button>
                <button
                  type="button"
                  title={`Send ${bot.name} a direct message (runs one turn in its chat, reply lands here)`}
                  onClick={() => { setDmTarget(bot); setDmText(""); setDmError(null); }}
                  className="thread-action thread-action-text text-[12px]"
                >
                  Message
                </button>
                <button
                  type="button"
                  title={bot.hidden ? `Unhide ${bot.name}` : `Hide ${bot.name}`}
                  onClick={() => void onUpdate(bot.id, { hidden: !bot.hidden }).catch(() => undefined)}
                  className="thread-action thread-action-text text-[12px]"
                >
                  {bot.hidden ? "Unhide" : "Hide"}
                </button>
                <button
                  type="button"
                  title={`Delete ${bot.name} (keeps its chat files)`}
                  onClick={() => void onDelete(bot)}
                  className="thread-action thread-action-text text-[12px] text-err"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        <div className="shrink-0 border-t border-line px-2 py-2">
          <div className="flex items-center gap-1 px-2.5 pb-1 pt-1">
            <span className="shelf-label">Groups{groups.length > 0 ? ` (${groups.length})` : ""}</span>
            <span className="shelf-divider" />
            <button
              type="button"
              title="New group"
              disabled={bots.filter((b) => !b.hidden).length < 2}
              onClick={() => { setGroupDialog({ mode: "new" }); setGroupName(""); setGroupMembers([]); setGroupError(null); }}
              className="thread-action thread-action-text text-[12px] disabled:opacity-50"
            >
              New group
            </button>
          </div>
          {groups.length === 0 ? (
            <p className="px-3 py-1 text-[12.5px] text-dim">No rooms yet. Groups need 2+ bots, members take serial turns in one shared room.</p>
          ) : (
            [...groups].sort((a, b) => a.name.localeCompare(b.name)).map((group) => (
              <div
                key={group.id}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 ${group.id === activeGroupId ? "bg-accent/10" : "hover:bg-raised"}`}
              >
                <button
                  type="button"
                  onClick={() => { onOpenGroup(group); onClose(); }}
                  title={`Open the ${group.name} room`}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <BotAvatar name={group.name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-semibold">{group.name}</span>
                      {group.id === activeGroupId ? <span className="text-[11px] font-semibold text-accent">● open</span> : null}
                    </span>
                    <span className="block truncate text-[12px] text-dim">
                      {group.memberIds.map((id) => bots.find((b) => b.id === id)?.name ?? "?").join(", ")}
                      {group.mainSessionFile ? " · has room" : " · no room yet"}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  title={`Edit ${group.name}`}
                  onClick={() => { setGroupDialog({ mode: "edit", group }); setGroupName(group.name); setGroupMembers([...group.memberIds]); setGroupError(null); }}
                  className="thread-action thread-action-text text-[12px]"
                >
                  Edit
                </button>
                <button
                  type="button"
                  title={`Delete ${group.name} (keeps its room files)`}
                  onClick={() => void onDeleteGroup(group)}
                  className="thread-action thread-action-text text-[12px] text-err"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        <p className="shrink-0 border-t border-line px-4 py-2 text-[12px] leading-5 text-dim">
          A bot's chat is forever, opening it resumes the same session. Mention teammates with @handle in a message to hand off quoted context explicitly. Deleting a bot keeps its chat files on disk.
        </p>

        {dialog ? (
          <div className="absolute inset-0 grid place-items-center bg-black/40 p-4">
            <div className="flex h-full w-[620px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-xl" role="dialog" aria-modal="true" aria-label={dialog.mode === "new" ? "New bot" : `Edit ${dialog.mode === "edit" ? dialog.bot.name : ""}`}>
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <h3 className="text-[14px] font-semibold">{dialog.mode === "new" ? "New bot" : "Edit bot"}</h3>
                <button type="button" onClick={() => setDialog(null)} aria-label="Cancel" className="thread-action ml-auto">✕</button>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-dim">Name</span>
                  <input value={form.name} onChange={(e) => set("name")(e.target.value)} placeholder="Reviewer" maxLength={48} className="w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px]" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-dim">Title (role)</span>
                  <input value={form.title} onChange={(e) => set("title")(e.target.value)} placeholder="Security reviewer" maxLength={80} className="w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px]" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-dim">Description</span>
                  <input value={form.description} onChange={(e) => set("description")(e.target.value)} placeholder="Reviews diffs for security issues before merge" maxLength={500} className="w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px]" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-dim">Persona (standing instructions)</span>
                  <textarea value={form.persona} onChange={(e) => set("persona")(e.target.value)} placeholder="Be terse. Always check auth boundaries first." rows={7} className="w-full rounded border border-line bg-raised px-2 py-1.5 font-mono text-[12.5px]" />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-semibold text-dim">Model provider (optional)</span>
                    <input value={form.modelProvider} onChange={(e) => set("modelProvider")(e.target.value)} placeholder="inherits global" className="w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px]" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-semibold text-dim">Model id (optional)</span>
                    <input value={form.modelId} onChange={(e) => set("modelId")(e.target.value)} placeholder="inherits global" className="w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px]" />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-dim">Home project (optional)</span>
                  <input value={form.cwd} onChange={(e) => set("cwd")(e.target.value)} placeholder="/path/to/project" className="w-full rounded border border-line bg-raised px-2 py-1.5 font-mono text-[12.5px]" />
                </label>
                {error ? <p role="alert" className="text-[12.5px] text-err">{error}</p> : null}
              </div>
              <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-2.5">
                <button type="button" onClick={() => setDialog(null)} className="context-button">Cancel</button>
                <button type="button" onClick={() => void save()} disabled={busy} className="context-button is-primary">
                  {busy ? "Saving…" : dialog.mode === "new" ? "Create bot" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {groupDialog ? (
          <div className="absolute inset-0 grid place-items-center bg-black/40 p-4">
            <div className="flex max-h-full w-[480px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-xl" role="dialog" aria-modal="true" aria-label={groupDialog.mode === "new" ? "New group" : "Edit group"}>
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <h3 className="text-[14px] font-semibold">{groupDialog.mode === "new" ? "New group" : "Edit group"}</h3>
                <button type="button" onClick={() => setGroupDialog(null)} aria-label="Cancel" className="thread-action ml-auto">✕</button>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                <label className="block">
                  <span className="mb-1 block text-[12px] font-semibold text-dim">Name</span>
                  <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Release crew" maxLength={48} className="w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px]" />
                </label>
                <fieldset className="block">
                  <legend className="mb-1 px-0 text-[12px] font-semibold text-dim">Members (2,6)</legend>
                  {bots.filter((b) => !b.hidden).length === 0 ? (
                    <p className="text-[12.5px] text-dim">Create bots first.</p>
                  ) : (
                    bots.filter((b) => !b.hidden).map((b) => (
                      <label key={b.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-raised">
                        <input
                          type="checkbox"
                          checked={groupMembers.includes(b.id)}
                          onChange={() => setGroupMembers((prev) => (prev.includes(b.id) ? prev.filter((id) => id !== b.id) : [...prev, b.id]))}
                        />
                        <BotAvatar name={b.name} size={18} />
                        <span className="text-[13px]">{b.name}</span>
                        {b.title ? <span className="truncate text-[12px] text-dim">{b.title}</span> : null}
                      </label>
                    ))
                  )}
                </fieldset>
                {groupError ? <p role="alert" className="text-[12.5px] text-err">{groupError}</p> : null}
              </div>
              <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-2.5">
                <button type="button" onClick={() => setGroupDialog(null)} className="context-button">Cancel</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const check = validateNewGroup({ name: groupName, memberIds: groupMembers });
                    if (!check.ok) {
                      setGroupError(check.error);
                      return;
                    }
                    setBusy(true);
                    const done = () => {
                      setBusy(false);
                      setGroupDialog(null);
                    };
                    if (groupDialog.mode === "edit") {
                      void onUpdateGroup(groupDialog.group.id, { name: check.value.name, memberIds: check.value.memberIds })
                        .then(done)
                        .catch((e: any) => {
                          setBusy(false);
                          setGroupError(e?.message ?? "Could not save the group");
                        });
                    } else {
                      void onCreateGroup({ name: check.value.name, memberIds: check.value.memberIds })
                        .then(done)
                        .catch((e: any) => {
                          setBusy(false);
                          setGroupError(e?.message ?? "Could not save the group");
                        });
                    }
                  }}
                  className="context-button is-primary"
                >
                  {busy ? "Saving…" : groupDialog.mode === "new" ? "Create group" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {dmTarget ? (
          <div className="absolute inset-0 grid place-items-center bg-black/40 p-4">
            <div className="flex max-h-full w-[480px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-bg shadow-xl" role="dialog" aria-modal="true" aria-label={`Message ${dmTarget.name}`}>
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <BotAvatar name={dmTarget.name} size={20} />
                <h3 className="text-[14px] font-semibold">Message {dmTarget.name}</h3>
                <button type="button" onClick={() => setDmTarget(null)} aria-label="Cancel" className="thread-action ml-auto">✕</button>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
                <p className="text-[12px] leading-5 text-dim">
                  Runs one turn in {dmTarget.name}'s chat. You stay here, the reply lands in your open chat as an attributed line. Needs an idle agent.
                </p>
                <textarea
                  value={dmText}
                  onChange={(e) => setDmText(e.target.value)}
                  placeholder={`Ask ${dmTarget.name}… (mention teammates with @handle)`}
                  rows={5}
                  className="w-full rounded border border-line bg-raised px-2 py-1.5 text-[13px]"
                />
                {dmError ? <p role="alert" className="text-[12.5px] text-err">{dmError}</p> : null}
              </div>
              <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-2.5">
                <button type="button" onClick={() => setDmTarget(null)} className="context-button">Cancel</button>
                <button
                  type="button"
                  disabled={dmBusy || !dmText.trim()}
                  onClick={() => {
                    setDmBusy(true);
                    setDmError(null);
                    void onSendMessage(dmTarget.id, dmText.trim())
                      .then(() => {
                        setDmBusy(false);
                        setDmTarget(null);
                      })
                      .catch((e: any) => {
                        setDmBusy(false);
                        setDmError(e?.message ?? "Could not send the message");
                      });
                  }}
                  className="context-button is-primary"
                >
                  {dmBusy ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** App-default template editor: full identity, snapshotted into new projects.
 *  Existing projects never auto-update (snapshot semantics). */
function DefaultBotSection({ initial, onSave }: { initial: DefaultBot; onSave: (input: DefaultBot) => Promise<void> }) {
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
    <div className="mb-2 rounded-md border border-line bg-raised px-3 py-2.5">
      <p className="text-[13px] font-semibold">Default bot</p>
      <p className="mt-0.5 text-[12px] leading-5 text-dim">
        Snapshotted into new projects as their default. Existing projects keep their copy.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-dim">Name</span>
          <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={48} className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px]" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-dim">Title</span>
          <input value={title} onChange={(e) => { setTitle(e.target.value); setSaved(false); }} maxLength={80} className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px]" />
        </label>
      </div>
      <label className="mt-2 block">
        <span className="mb-1 block text-[12px] font-semibold text-dim">Persona</span>
        <textarea value={persona} onChange={(e) => { setPersona(e.target.value); setSaved(false); }} rows={3} placeholder="Empty persona chats like today's default." className="w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-[12px]" />
      </label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-dim">Model provider</span>
          <input value={provider} onChange={(e) => { setProvider(e.target.value); setSaved(false); }} placeholder="inherits global" className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px]" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-dim">Model id</span>
          <input value={modelId} onChange={(e) => { setModelId(e.target.value); setSaved(false); }} placeholder="inherits global" className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px]" />
        </label>
      </div>
      {error ? <p role="alert" className="mt-1.5 text-[12px] text-err">{error}</p> : null}
      <div className="mt-2 flex items-center gap-2">
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
        {saved && !dirty ? <span className="text-[12px] text-ok">Saved</span> : null}
      </div>
    </div>
  );
}
