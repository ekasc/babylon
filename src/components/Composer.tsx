import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo } from "../bridge";
import { commandTokenAtStart, insertCommand, rankCommands } from "../commands";
import CommandMenu from "./CommandMenu";
import ModelPicker from "./ComposerModelPicker";
import PermissionModePicker from "./PermissionModePicker";
import ThinkingPicker from "./ComposerThinkingPicker";
import StatsPopover from "./StatsPopover";
import { PaperclipIcon, SendIcon, StopIcon, XIcon } from "./icons";

export interface Attachment {
  name: string;
  mimeType: string;
  /** base64 payload (no data: prefix) */
  data: string;
  /** preview data URL */
  url: string;
}

interface ComposerDialog {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

interface Props {
  streaming: boolean;
  steering: string[];
  followUp: string[];
  commands: CommandInfo[];
  agentState: any;
  stats: any;
  models: any[];
  thinkingLevels: string[];
  draftRequest?: { id: number; text: string } | null;
  toast(kind: "info" | "warning" | "error", text: string): void;
  onSend(text: string, images: Attachment[] | undefined, streamingBehavior?: "steer" | "followUp"): Promise<boolean>;
  onAbort(): void;
  onSetModel(provider: string, modelId: string): void;
  onSetThinking(level: string): void;
  onCompact(): void;
  dialogs?: ComposerDialog[];
  onDialogDismiss?: (id: string) => void;
}

function trunc(s: string, n = 42): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1280;
const MAX_PASTE_TEXT_CHARS = 2000;

async function prepareImage(file: File): Promise<{ blob: Blob; mimeType: string }> {
  // Preserve animated GIFs; drawing one to canvas would silently drop frames.
  if (file.type === "image/gif") return { blob: file, mimeType: file.type };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { blob: file, mimeType: file.type };
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) return { blob: file, mimeType: file.type };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("image canvas unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("image resize failed"))), mimeType, 0.85)
    );
    return { blob, mimeType };
  } finally {
    bitmap.close();
  }
}

const Composer = memo(function Composer({ streaming, steering, followUp, commands, agentState, stats, models, thinkingLevels, draftRequest, toast, onSend, onAbort, onSetModel, onSetThinking, onCompact, dialogs, onDialogDismiss }: Props) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"steer" | "followUp">("steer");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  const commandToken = commandTokenAtStart(text);
  const commandMatches = useMemo(
    () => (commandToken !== null && commandToken !== dismissedToken ? rankCommands(commands, commandToken, 16) : []),
    [commandToken, commands, dismissedToken]
  );

  useEffect(() => setSelectedCommand(0), [commandToken]);
  useEffect(() => {
    if (!draftRequest) return;
    setText(draftRequest.text);
    setDismissedToken(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [draftRequest]);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.url);
    },
    []
  );

  const addFiles = async (files: ArrayLike<File>) => {
    const added: Attachment[] = [];
    let rejected = 0;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/") || f.size > MAX_IMAGE_BYTES) {
        rejected++;
        continue;
      }
      try {
        const prepared = await prepareImage(f);
        const data = await readAsBase64(prepared.blob);
        added.push({
          name: f.name || "image",
          mimeType: prepared.mimeType,
          data,
          url: URL.createObjectURL(prepared.blob),
        });
      } catch {
        rejected++;
      }
    }
    if (added.length) {
      setAttachments((a) => [...a, ...added]);
      setAttachmentError(null);
    }
    if (rejected) setAttachmentError(`${rejected} image${rejected === 1 ? " was" : "s were"} not attached.`);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    const pastedText = e.clipboardData?.getData("text/plain") ?? "";
    if (pastedText.length > MAX_PASTE_TEXT_CHARS) {
      e.preventDefault();
      const fileName = `pasted-text-${Date.now().toString().slice(-6)}.txt`;
      const blob = new Blob([pastedText], { type: "text/plain" });
      void (async () => {
        const data = await readAsBase64(blob);
        const url = URL.createObjectURL(blob);
        setAttachments((a) => [...a, { name: fileName, mimeType: "text/plain", data, url }]);
        setAttachmentError(null);
        toast("info", `Pasted text (${pastedText.length} chars) added as ${fileName}`);
      })();
    }
  };

  const submit = async () => {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    if (sending && !streaming) return;
    const imageAttachments = attachments.filter((a) => a.mimeType.startsWith("image/"));
    const textAttachments = attachments.filter((a) => a.mimeType.startsWith("text/"));
    let messageText = t;
    if (textAttachments.length) {
      const decoded = textAttachments.map((a) => {
        try {
          return atob(a.data);
        } catch {
          return "";
        }
      });
      const fileBlocks = decoded.map((content, idx) => `[File: ${textAttachments[idx].name}]\n${content}`).join("\n\n");
      messageText = messageText ? `${messageText}\n\n${fileBlocks}` : fileBlocks;
    }
    const outgoing = imageAttachments;
    const isStreamingSubmit = streaming;
    if (!isStreamingSubmit) setSending(true);
    setText("");
    try {
      const accepted = await onSend(messageText, outgoing.length ? outgoing : undefined, isStreamingSubmit ? mode : undefined);
      if (!accepted) {
        setText(t);
        return;
      }
    } finally {
      if (!isStreamingSubmit) setSending(false);
    }
    for (const attachment of attachments) URL.revokeObjectURL(attachment.url);
    setAttachments([]);
  };

  const chooseCommand = (command: CommandInfo) => {
    setText(insertCommand(command));
    setDismissedToken(null);
    requestAnimationFrame(() => {
      const textarea = composerRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  };

  const hasBlockingDialog = !!dialogs?.[0] && (dialogs[0].method === "select" || dialogs[0].method === "input" || dialogs[0].method === "editor");

  useEffect(() => {
    if (!hasBlockingDialog || !dialogs?.[0]?.options?.length) return;
    const onNumber = async (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const idx = Number(e.key) - 1;
      const opts = dialogs[0].options as string[];
      if (idx < 0 || idx >= opts.length || idx >= 9) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      e.preventDefault();
      const id = dialogs[0].id;
      const value = opts[idx];
      onDialogDismiss?.(id);
      try {
        const { bridge: b } = await import("../bridge");
        await b.uiRespond({ id, value });
      } catch (err: any) {
        toast?.("error", (err as Error)?.message ?? "failed");
      }
    };
    window.addEventListener("keydown", onNumber);
    return () => window.removeEventListener("keydown", onNumber);
  }, [hasBlockingDialog, dialogs, onDialogDismiss, toast]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (hasBlockingDialog) {
      e.preventDefault();
      return;
    }
    if (commandMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSelectedCommand((index) =>
        e.key === "ArrowDown"
          ? (index + 1) % commandMatches.length
          : (index - 1 + commandMatches.length) % commandMatches.length
      );
      return;
    }
    if (commandMatches.length && e.key === "Escape") {
      e.preventDefault();
      setDismissedToken(commandToken);
      return;
    }
    if (commandMatches.length && e.key === "Tab") {
      e.preventDefault();
      chooseCommand(commandMatches[selectedCommand] ?? commandMatches[0]);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const selected = commandMatches[selectedCommand] ?? commandMatches[0];
      if (selected && commandToken !== selected.name) chooseCommand(selected);
      else void submit();
    }
  };

  return (
    <div
      className={`composer-dock shrink-0 overflow-visible px-4 pb-4 pt-3 sm:px-7 sm:pb-5 ${dragOver ? "is-dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void addFiles(e.dataTransfer?.files ?? []);
      }}
    >
      <div className="relative mx-auto w-full max-w-[760px] min-w-0">
        <CommandMenu
          commands={commandMatches}
          selected={selectedCommand}
          onSelect={setSelectedCommand}
          onChoose={chooseCommand}
        />
        {streaming && (steering.length > 0 || followUp.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5 text-[13px]">
            {steering.map((s, i) => (
              <span key={`s${i}`} className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">
                steer · {trunc(s)}
              </span>
            ))}
            {followUp.map((s, i) => (
              <span key={`f${i}`} className="rounded-full bg-inset px-2 py-0.5 text-dim">
                queued · {trunc(s)}
              </span>
            ))}
          </div>
        )}

        {attachmentError ? <p className="mb-2 text-[13px] text-err">{attachmentError}</p> : null}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a, i) => {
              const isText = a.mimeType.startsWith("text/");
              return (
                <div key={i} className="group relative">
                  {isText ? (
                    <div className="flex h-14 min-w-[120px] items-center gap-2 rounded-lg border border-line bg-inset px-3" title={a.name}>
                      <span className="grid h-7 w-7 place-items-center rounded bg-accent-soft text-accent text-[10px] font-bold">TXT</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{a.name}</span>
                      <span className="text-[11px] text-dim">{Math.round((a.data.length * 3) / 4 / 1024)}KB</span>
                    </div>
                  ) : (
                    <img src={a.url} alt={a.name} title={a.name} className="h-14 w-14 rounded-lg border border-line object-cover" />
                  )}
                  <button
                    onClick={() =>
                      setAttachments((list) => {
                        URL.revokeObjectURL(list[i]?.url ?? "");
                        return list.filter((_, j) => j !== i);
                      })
                    }
                    aria-label={`Remove attachment ${a.name}`}
                    className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-fg text-bg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
                  >
                    <XIcon size={9} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {streaming && !hasBlockingDialog ? (
          <div role="status" aria-live="polite" aria-atomic="true" className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-inset px-3 py-2 text-[12px] text-dim">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-dim" aria-hidden="true" />
            Agent is running
          </div>
        ) : null}
        <div className="composer-surface">
          {dialogs?.[0] ? (
            <div role="dialog" aria-modal="true" aria-labelledby="composer-dialog-title" className="border-b border-line/60 bg-raised/40 px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p id="composer-dialog-title" className="text-[13.5px] font-semibold leading-snug tracking-tight">{dialogs[0].title ?? "Question"}</p>
                  {dialogs[0].message && <p className="mt-1 text-[12.5px] leading-relaxed text-dim">{dialogs[0].message}</p>}
                </div>
                <button
                  onClick={async () => {
                    const id = dialogs[0].id;
                    onDialogDismiss?.(id);
                    try {
                      const { bridge: b } = await import("../bridge");
                      await b.uiRespond({ id, cancelled: true });
                    } catch {}
                  }}
                  className="shrink-0 rounded-md p-1 text-dim hover:bg-inset hover:text-fg"
                  aria-label="Dismiss — deny the question"
                >
                  ✕
                </button>
              </div>
              {dialogs[0].method === "select" && Array.isArray(dialogs[0].options) ? (
                <div className="mt-3 flex flex-col gap-1">
                  {dialogs[0].options!.map((o: string, idx: number) => (
                    <button
                      key={`${o}-${idx}`}
                      onClick={async () => {
                        const id = dialogs[0].id;
                        onDialogDismiss?.(id);
                        try {
                          const { bridge: b } = await import("../bridge");
                          await b.uiRespond({ id, value: o });
                        } catch (e: any) {
                          toast?.("error", e?.message ?? "failed");
                        }
                      }}
                      className="flex w-full items-center justify-between rounded-lg border border-line bg-bg px-3 py-2 text-left text-[13px] hover:border-accent/50 hover:bg-accent/5 hover:text-accent transition-colors"
                    >
                      <span className="flex items-center gap-2"><span className="grid h-5 w-5 place-items-center rounded bg-inset text-[11px] font-medium text-dim">{idx + 1}</span>{o}</span>
                      <span className="text-[11px] text-dim">{idx + 1} ↩</span>
                    </button>
                  ))}
                </div>
              ) : dialogs[0].method === "input" || dialogs[0].method === "editor" ? (
                <ComposerDialogInput dialog={dialogs[0]} onDismiss={onDialogDismiss!} toast={toast} />
              ) : null}
              <p className="mt-2 text-[11px] text-dim">Press 1–{Math.min(9, dialogs[0].options?.length ?? 0)} to choose, or deny with ✕ / Esc.</p>
            </div>
          ) : null}
          {!hasBlockingDialog && (
            <div className="flex items-end gap-1.5 px-2 pt-2 pb-1">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles(e.target.files ?? []);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            title="Attach images (or paste / drag & drop)"
            aria-label="Attach image"
            disabled={hasBlockingDialog}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-inset hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <PaperclipIcon size={15} />
          </button>
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            disabled={hasBlockingDialog}
            placeholder={
              streaming
                ? mode === "steer"
                  ? "Steer the agent mid-run…"
                  : "Queue a follow-up message…"
                : "Ask Pi to change, inspect, or explain something"
            }
            role="combobox"
            aria-label="Message Pi"
            aria-autocomplete="list"
            aria-expanded={commandMatches.length > 0}
            aria-controls={commandMatches.length > 0 ? "composer-commands" : undefined}
            aria-activedescendant={commandMatches.length > 0 ? `cmd-opt-${selectedCommand}` : undefined}
            className="composer flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-dim"
          />

          {streaming ? (
            <div className="composer-stream-controls shrink-0" role="group" aria-label="Message delivery and run controls">
              <button
                onClick={() => setMode("steer")}
                title="Interrupt and redirect the current run"
                aria-pressed={mode === "steer"}
                className={`composer-stream-option ${mode === "steer" ? "is-active" : ""}`}
              >
                Steer
              </button>
              <button
                onClick={() => setMode("followUp")}
                title="Deliver when the current run finishes"
                aria-pressed={mode === "followUp"}
                className={`composer-stream-option ${mode === "followUp" ? "is-active" : ""}`}
              >
                Queue
              </button>
              <button onClick={onAbort} title="Stop current run" aria-label="Stop current run" className="composer-stream-stop">
                <StopIcon size={13} />
              </button>
            </div>
          ) : (
            <button
              onClick={submit}
              disabled={sending || (!text.trim() && attachments.length === 0)}
              title="Send message"
              className="operator-send shrink-0"
            >
              <SendIcon size={14} />
              {sending ? "Sending…" : "Send"}
            </button>
          )}
          </div>
          )}
          {!hasBlockingDialog && (
            <div className="composer-meta">
              <div className="flex min-w-0 items-center gap-1.5">
                <PermissionModePicker />
                <ModelPicker models={models} current={agentState?.model ?? null} disabled={!models.length} onSelect={onSetModel} />
                <ThinkingPicker current={agentState?.thinkingLevel ?? "off"} available={thinkingLevels.length ? thinkingLevels : undefined} disabled={!agentState} onSelect={onSetThinking} />
                <StatsPopover stats={stats} hasSession={!!agentState} onCompact={onCompact} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

function ComposerDialogInput({ dialog, onDismiss, toast }: { dialog: ComposerDialog; onDismiss: (id: string) => void; toast: Props["toast"] }) {
  const [value, setValue] = useState(dialog.prefill ?? "");
  const respond = async (payload: Record<string, unknown>) => {
    onDismiss(dialog.id);
    try {
      const { bridge } = await import("../bridge");
      await bridge.uiRespond({ id: dialog.id, ...payload });
    } catch (e: any) {
      toast("error", e?.message ?? "failed to answer");
    }
  };
  return (
    <div className="mt-2 flex flex-col gap-2">
      {dialog.method === "input" ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={dialog.placeholder}
          onKeyDown={(e) => e.key === "Enter" && void respond({ value })}
          className="rounded-lg border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent"
        />
      ) : (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          className="resize-y rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[12px] outline-none focus:border-accent"
        />
      )}
      <div className="flex justify-end gap-2">
        <button onClick={() => void respond({ cancelled: true })} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px]">
          Cancel
        </button>
        <button onClick={() => void respond({ value })} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg">
          Submit
        </button>
      </div>
    </div>
  );
}

export default Composer;
