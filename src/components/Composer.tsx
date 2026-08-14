import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo } from "../bridge";
import { commandTokenAtStart, insertCommand, rankCommands } from "../commands";
import CommandMenu from "./CommandMenu";
import ModelPicker from "./ModelPicker";
import ThinkingPicker from "./ThinkingPicker";
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
  onSend(text: string, images: Attachment[] | undefined, streamingBehavior?: "steer" | "followUp"): Promise<boolean>;
  onAbort(): void;
  onSetModel(provider: string, modelId: string): void;
  onSetThinking(level: string): void;
  onCompact(): void;
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

const Composer = memo(function Composer({ streaming, steering, followUp, commands, agentState, stats, models, thinkingLevels, draftRequest, onSend, onAbort, onSetModel, onSetThinking, onCompact }: Props) {
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
    }
  };

  const submit = async () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || sending) return;
    const outgoing = attachments;
    setSending(true);
    // Clear optimistically: the sent text must leave the box the moment the
    // user submits, not when the (possibly slow) prompt pipeline resolves.
    setText("");
    try {
      const accepted = await onSend(t, outgoing.length ? outgoing : undefined, streaming ? mode : undefined);
      if (!accepted) {
        setText(t); // restore the draft on failure
        return;
      }
    } finally {
      setSending(false);
    }
    for (const attachment of outgoing) URL.revokeObjectURL(attachment.url);
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      className={`composer-dock shrink-0 px-7 pb-5 pt-3 ${dragOver ? "is-dragging" : ""}`}
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
      <div className="relative mx-auto max-w-[760px]">
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
            {attachments.map((a, i) => (
              <div key={i} className="group relative">
                <img
                  src={a.url}
                  alt={a.name}
                  title={a.name}
                  className="h-14 w-14 rounded-lg border border-line object-cover"
                />
                <button
                  onClick={() =>
                    setAttachments((list) => {
                      URL.revokeObjectURL(list[i]?.url ?? "");
                      return list.filter((_, j) => j !== i);
                    })
                  }
                  title="Remove"
                  className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-fg text-bg opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <XIcon size={9} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer-surface">
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
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-inset hover:text-fg"
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
            placeholder={
              streaming
                ? mode === "steer"
                  ? "Steer the agent mid-run…"
                  : "Queue a follow-up message…"
                : "Ask Pi to change, inspect, or explain something"
            }
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={commandMatches.length > 0}
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
          <div className="composer-meta">
            <div className="flex min-w-0 items-center gap-1.5">
              <ModelPicker models={models} current={agentState?.model ?? null} disabled={!models.length} onSelect={onSetModel} />
              <ThinkingPicker current={agentState?.thinkingLevel ?? "off"} available={thinkingLevels.length ? thinkingLevels : undefined} disabled={!agentState} onSelect={onSetThinking} />
              <StatsPopover stats={stats} hasSession={!!agentState} onCompact={onCompact} />
            </div>
            <span className="ml-auto text-[12px] text-dim">Enter to send · Shift+Enter for newline</span>
          </div>
        </div>
      </div>
    </div>
  );
});

export default Composer;
