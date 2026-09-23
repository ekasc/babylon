import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo } from "../bridge";
import type { AgentModel, AgentState, SessionStats } from "../bridge";
import type { Dialog } from "../store";
import type { Bot } from "../bots";
import { expandSkillMentions } from "../lib/skillRef";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_SEND_ATTACHMENTS,
  MAX_SEND_INPUT_CHARS,
  PASTE_AS_TEXT_ARM_MS,
  effectiveFileMimeType,
  isHeicFile,
  isPasteAsTextShortcutKey,
  nextPastedTextName,
  shouldAttachPastedText,
} from "../lib/attachments";
import { truncate } from "../lib/string";
import { errorMessage } from "../lib/errors";
import { useComposerAutocomplete } from "./useComposerAutocomplete";
import PermissionModePicker from "./PermissionModePicker";
import ModelPicker from "./ComposerModelPicker";
import ThinkingPicker from "./ComposerThinkingPicker";
import StatsPopover from "./StatsPopover";
import { BookmarkIcon, PaperclipIcon, SendIcon, StopIcon, XIcon } from "./icons";

/** Live run indicator. Idle-dimmed so the row reads quiet until a run starts. */
function ThroughputBars({ active }: { active: boolean }) {
	return (
		<span className={`throughput-bars inline-flex items-end gap-[2px] leading-none ${active ? "text-dim" : "text-dim/35"}`} title={active ? "Agent is running" : "Idle"} aria-hidden="true">
			{[0, 1, 2, 3, 4].map((i) => (
				<span
					key={i}
					className={`throughput-bar ${active ? "is-active" : "is-idle"}`}
					style={{ animationDelay: `${i * 90}ms` }}
					aria-hidden
				/>
			))}
		</span>
	);
}

export interface Attachment {
	name: string;
	mimeType: string;
	data: string;
	url: string;
}

interface Props {
	streaming: boolean;
	steering: string[];
	followUp: string[];
	commands: CommandInfo[];
	agentState?: AgentState | null;
	stats?: SessionStats | null;
	models?: AgentModel[];
	thinkingLevels: string[];
	draftRequest?: { id: number; text: string; append?: boolean } | null;
	/** Session identity for per-session draft persistence. Null skips it. */
	sessionKey?: string | null;
	toast(kind: "info" | "warning" | "error", text: string): void;
	onSend(text: string, images: Attachment[] | undefined, streamingBehavior?: "steer" | "followUp"): Promise<boolean>;
	onAbort(): void;
	onSetModel(provider: string, modelId: string): void;
	onSetThinking(level: string): void;
	onCompact(): void;
	dialogs?: Dialog[];
	onDialogDismiss?: (id: string) => void;
	/** Bots offered for @-mention completion (room members in rooms). */
	mentionBots?: Bot[];
	/** Goal composer mode: off | armed (next send starts it) | active. */
	goalMode?: "off" | "armed" | "active";
	/** Active goal objective, for the pursuing tooltip. Null when none. */
	goalObjective?: string | null;
	/** Toggle: arm/disarm when idle, cancel when pursuing. */
	onToggleGoal?: () => void;
	/** Design composer mode: off | armed (next send starts it) | active. */
	designMode?: "off" | "armed" | "active";
	/** Active stage key for the indicator (elicit, brief-confirm, brand, build). */
	designStage?: string;
	/** Active design subject, for the indicator tooltip. Null when none. */
	designSubject?: string | null;
	/** Toggle: arm when off, disarm when armed. Active designs end/restart
	    through the indicator menu, never by toggling off. */
	onToggleDesign?: () => void;
	/** End the active design (mark done). From the indicator menu. */
	onEndDesign?: () => void;
	/** Clear the design and arm the next send (fresh subject). From the menu. */
	onRestartDesign?: () => void;
	/** Pending design approval (brief/brand), if any: one button in the row, never a strip. */
	designApproval?: { label: string; onApprove(): void } | null;
}

function trunc(s: string, n = 42): string {
	const one = s.replace(/\s+/g, " ").trim();
	return truncate(one, n);
}

/** Indicator labels for live design stages (idle/done never display). */
function designStageLabel(stage: string): string {
	switch (stage) {
		case "elicit":
			return "Interview";
		case "brief-confirm":
			return "Brief";
		case "brand":
			return "Brand";
		case "build":
			return "Build";
		default:
			return "Active";
	}
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

const MAX_IMAGE_EDGE = 1280;
const DRAFT_MAX_CHARS = 20000;
const draftKey = (sessionKey: string) => `babylon:composer-draft:${sessionKey}`;

let imageWorker: Worker | null = null;
function getImageWorker(): Worker | null {
  if (imageWorker) return imageWorker;
  try {
    if (typeof OffscreenCanvas === "undefined") return null;
    imageWorker = new Worker(new URL("../imageWorker.ts", import.meta.url), { type: "module" });
    return imageWorker;
  } catch { return null; }
}
let imageSeq = 0;
function prepareImageViaWorker(file: File): Promise<{ blob: Blob; mimeType: string } | null> {
  const w = getImageWorker();
  if (!w || file.type === "image/gif") return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = ++imageSeq;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      w!.removeEventListener("message", onMsg);
      if (e.data.ok && e.data.blob) resolve({ blob: e.data.blob, mimeType: e.data.blob.type || file.type });
      else resolve(null);
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, blob: file, maxEdge: MAX_IMAGE_EDGE });
    setTimeout(() => { w.removeEventListener("message", onMsg); resolve(null); }, 2500);
  });
}

async function prepareImage(file: File): Promise<{ blob: Blob; mimeType: string }> {
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

const Composer = memo(function Composer({
	streaming,
	steering,
	followUp,
	commands,
	agentState,
	stats,
	models = [],
	thinkingLevels = [],
	draftRequest,
	sessionKey = null,
	toast,
	onSend,
	onAbort,
	onSetModel,
	onSetThinking,
	onCompact,
	dialogs,
	onDialogDismiss,
	mentionBots = [],
	goalMode = "off",
	goalObjective = null,
	onToggleGoal,
	designMode = "off",
	designStage = "idle",
	designSubject = null,
	onToggleDesign,
	onEndDesign,
	onRestartDesign,
	designApproval = null,
}: Props) {
	const [text, setText] = useState("");
	const [designMenuOpen, setDesignMenuOpen] = useState(false);
	// Transient menu state never survives a session switch.
	useEffect(() => {
		setDesignMenuOpen(false);
	}, [sessionKey]);
	const [mode, setMode] = useState<"steer" | "followUp">("followUp");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [dragOver, setDragOver] = useState(false);
	const [sending, setSending] = useState(false);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [history, setHistory] = useState<string[]>(() => {
		try { return JSON.parse(localStorage.getItem("babylon:composer-history") ?? "[]"); } catch { return []; }
	});
	const [historyCursor, setHistoryCursor] = useState<number | null>(null);
	// Draft persistence (per session): typed text survives reloads and session
	// switches. Saves run against a key ref so a session switch never files
	// the outgoing text under the incoming key; loads run on key change (ahead
	// of draftRequest below, so explicit requests still win). Accepted sends
	// clear the text, which deletes the saved draft through the save below.
	const sessionKeyRef = useRef(sessionKey);
	useEffect(() => {
		sessionKeyRef.current = sessionKey;
	});
	useEffect(() => {
		if (!sessionKey) return;
		try {
			const saved = localStorage.getItem(draftKey(sessionKey));
			setText(saved ? saved.slice(0, DRAFT_MAX_CHARS) : "");
		} catch {}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionKey]);
	useEffect(() => {
		const key = sessionKeyRef.current;
		if (!key) return;
		try {
			if (text) localStorage.setItem(draftKey(key), text.slice(0, DRAFT_MAX_CHARS));
			else localStorage.removeItem(draftKey(key));
		} catch {}
	}, [text]);
	// Prompt stash (T3): park the current draft with Cmd/Ctrl+S and pull it
	// back later. Text-only by design — attachments stay in the composer so a
	// stash never orphans a file pick. Restoring removes the entry.
	const [stash, setStash] = useState<Array<{ id: number; text: string; at: number }>>([]);
	const [stashOpen, setStashOpen] = useState(false);
	// Custom answer for a select dialog: any text typed here wins over the
	// option buttons, so a free-form description (e.g. picking "something
	// else") always reaches the agent instead of being dropped.
	const [dialogText, setDialogText] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const attachmentsRef = useRef<Attachment[]>([]);
	// Paste-as-text arming (T3): mod+Shift+V on keydown opens a short window
	// in which paste skips attachment conversion, because clipboard events
	// carry no modifier state of their own.
	const pasteAsTextUntilRef = useRef(0);
	// Autocomplete cluster (slash-commands, @-mentions, $-skills): trigger
	// detection, ranked menus, dismissal, portal, and menu keys.
	// Autocomplete cluster (slash-commands, @-mentions, $-skills): trigger
	// detection, ranked menus, dismissal, portal, and menu keys.
	// Composer popovers portal to document.body: the session footer (and the
	// sketch theme's overflow:hidden on it) would otherwise clip anything
	// opening upward. Fixed z-60 sits above chat content but below modal
	// surfaces (palette, popovers, toasts at z-70).
	const menuAnchorRef = useRef<HTMLDivElement>(null);
	const ac = useComposerAutocomplete({ text, setText, commands, mentionBots, composerRef, menuAnchorRef });
	useEffect(() => {
		if (!draftRequest) return;
		if (draftRequest.append) {
			setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${draftRequest.text}` : draftRequest.text));
		} else {
			setText(draftRequest.text);
		}
		ac.clearDismissals();
		requestAnimationFrame(() => composerRef.current?.focus());
		// eslint-disable-next-line react-hooks/exhaustive-deps
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
		const heicNames: string[] = [];
		// Reserve against the per-message cap so concurrent adds can't
		// overshoot it (T3 counts in-flight uploads the same way).
		const slots = Math.max(0, MAX_SEND_ATTACHMENTS - attachments.length);
		for (const f of Array.from(files)) {
			if (added.length >= slots) {
				rejected++;
				continue;
			}
			if (f.size > MAX_ATTACHMENT_BYTES) {
				rejected++;
				continue;
			}
			// No HEIC decoder ships yet: reject with guidance instead of
			// silently sending an unreadable original to the model.
			if (isHeicFile(f.name, f.type)) {
				heicNames.push(f.name || "image");
				continue;
			}
			// Typeless drags (other apps, shells) get extension-inferred
			// MIME so a plain photo.jpg still lands on the image path.
			const mime = effectiveFileMimeType(f.name, f.type);
			try {
				if (mime.startsWith("image/")) {
					const viaWorker = await prepareImageViaWorker(f);
					const prepared = viaWorker ?? (await prepareImage(f));
					const data = await readAsBase64(prepared.blob);
					added.push({ name: f.name || "image", mimeType: prepared.mimeType || mime, data, url: URL.createObjectURL(prepared.blob) });
				} else {
					const data = await readAsBase64(f);
					const url = URL.createObjectURL(f);
					added.push({ name: f.name || "file", mimeType: mime, data, url });
				}
			} catch {
				rejected++;
			}
		}
		if (added.length) {
			setAttachments((a) => [...a, ...added]);
			setAttachmentError(null);
		}
		const problems: string[] = [];
		if (heicNames.length) problems.push(`${heicNames.join(", ")} ${heicNames.length === 1 ? "is" : "are"} HEIC/HEIF, which can't be read here yet — convert to JPEG or PNG first.`);
		if (rejected) problems.push(`${rejected} file${rejected === 1 ? " was" : "s were"} not attached (max ${MAX_SEND_ATTACHMENTS} files, ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB each).`);
		setAttachmentError(problems.length ? problems.join(" ") : null);
	};

	const onPaste = (e: React.ClipboardEvent) => {
		// Armed by mod+Shift+V on keydown: let the text land inline.
		if (Date.now() < pasteAsTextUntilRef.current) return;
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
		if (shouldAttachPastedText(pastedText)) {
			e.preventDefault();
			const fileName = nextPastedTextName(attachments.map((a) => a.name));
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
		const fileAttachments = attachments.filter((a) => !a.mimeType.startsWith("image/"));
		let messageText = expandSkillMentions(t, ac.skillCommands.map((c) => c.name));
		if (fileAttachments.length) {
			const decoded = fileAttachments.map((a) => {
				try {
					return atob(a.data);
				} catch {
					return "";
				}
			});
			const fileBlocks = decoded.map((content, idx) => {
				const f = fileAttachments[idx];
				if (!f) return "";
				const isTextLike = f.mimeType.startsWith("text/") || f.mimeType === "application/json" || f.name.match(/\.(txt|md|json|csv|log|js|ts|tsx|py|sh|yaml|yml)$/i);
				if (isTextLike) return `[File: ${f.name}]\n${content}`;
				return `[File: ${f.name} (${f.mimeType}, ${Math.round((f.data.length * 3) / 4 / 1024)}KB)]`;
			}).join("\n\n");
			messageText = messageText ? `${messageText}\n\n${fileBlocks}` : fileBlocks;
		}
		const outgoing = imageAttachments;
		const isStreamingSubmit = streaming;
		// Send caps (T3's send-turn contract): fail in the composer with a
		// message instead of downstream as provider errors.
		if (attachments.length > MAX_SEND_ATTACHMENTS) {
			setAttachmentError(`You can attach up to ${MAX_SEND_ATTACHMENTS} files per message.`);
			return;
		}
		if (messageText.length > MAX_SEND_INPUT_CHARS) {
			toast("error", `Message is ${messageText.length.toLocaleString()} characters; the limit is ${MAX_SEND_INPUT_CHARS.toLocaleString()}. Trim text or move some into a file attachment.`);
			return;
		}
		// remember for ArrowUp history (cap 50, dedupe consecutive)
		if (t) {
			setHistory((prev) => {
				if (prev[prev.length - 1] === t) return prev;
				const next = [...prev, t].slice(-50);
				try { localStorage.setItem("babylon:composer-history", JSON.stringify(next)); } catch {}
				return next;
			});
		}
		setHistoryCursor(null);
		setStashOpen(false);
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
			// Keep the keyboard flow: the composer owns focus after every
			// submit so abort → send-another-prompt never drops keystrokes.
			requestAnimationFrame(() => composerRef.current?.focus());
		}
		for (const attachment of attachments) URL.revokeObjectURL(attachment.url);
		setAttachments([]);
	};

	const dialog = dialogs?.[0];
	const hasBlockingDialog = dialog !== undefined && (dialog.method === "select" || dialog.method === "input" || dialog.method === "editor");

	// A fresh dialog starts with an empty custom-answer box.
	useEffect(() => setDialogText(""), [dialogs?.[0]?.id]);

	useEffect(() => {
		if (!hasBlockingDialog || !dialogs?.[0]?.options?.length) return;
		const onNumber = async (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (!/^[1-9]$/.test(e.key)) return;
			const idx = Number(e.key) - 1;
			if (!dialog) return;
			const opts = dialog.options;
			if (!Array.isArray(opts)) return;
			if (idx < 0 || idx >= opts.length || idx >= 9) return;
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
			e.preventDefault();
			// Typed text wins over the numeric shortcut (matches the buttons).
			const value = dialogText.trim() || opts[idx];
			const id = dialog.id;
			onDialogDismiss?.(id);
			try {
				const { bridge: b } = await import("../bridge");
				await b.uiRespond({ id, value });
			} catch (err) {
				toast?.("error", (err as Error)?.message ?? "failed");
			}
		};
		window.addEventListener("keydown", onNumber);
		return () => window.removeEventListener("keydown", onNumber);
	}, [hasBlockingDialog, dialogs, onDialogDismiss, toast, dialogText]);

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (hasBlockingDialog) {
			e.preventDefault();
			return;
		}
		if (isPasteAsTextShortcutKey(e)) {
			pasteAsTextUntilRef.current = Date.now() + PASTE_AS_TEXT_ARM_MS;
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
			e.preventDefault();
			const trimmed = text.trim();
			if (!trimmed) return;
			setStash((list) => [{ id: Date.now(), text: trimmed, at: Date.now() }, ...list].slice(0, 20));
			setText("");
			setHistoryCursor(null);
			setStashOpen(false);
			toast?.("info", "Draft stashed");
			return;
		}
		// Autocomplete menus own their keys (arrows/Tab/Escape/accept). Enter
		// on an already-accepted row falls through to submit below.
		if (ac.handleMenuKey(e)) return;
		if (e.key === "Escape" && stashOpen) {
			e.preventDefault();
			setStashOpen(false);
			return;
		}
		const menuOpen = ac.menusOpen;
		if (!menuOpen && e.key === "ArrowUp") {
			const el = e.currentTarget;
			const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
			const isEmpty = text.trim() === "";
			if (!atStart && !isEmpty && historyCursor === null) return;
			if (history.length === 0) return;
			e.preventDefault();
			const nextIdx = historyCursor === null ? history.length - 1 : Math.max(0, historyCursor - 1);
			setHistoryCursor(nextIdx);
			const nextText = history[nextIdx] ?? "";
			setText(nextText);
			requestAnimationFrame(() => {
				const ta = composerRef.current;
				if (ta) { ta.focus(); ta.setSelectionRange(nextText.length, nextText.length); autoGrow(ta); }
			});
			return;
		}
		if (!menuOpen && e.key === "ArrowDown") {
			if (historyCursor === null) return;
			e.preventDefault();
			const nextIdx = historyCursor + 1;
			if (nextIdx >= history.length) {
				setHistoryCursor(null);
				setText("");
				requestAnimationFrame(() => { const ta = composerRef.current; if (ta) { ta.focus(); autoGrow(ta); } });
			} else {
				setHistoryCursor(nextIdx);
				const nextText = history[nextIdx] ?? "";
				setText(nextText);
				requestAnimationFrame(() => {
					const ta = composerRef.current;
					if (ta) { ta.focus(); ta.setSelectionRange(nextText.length, nextText.length); autoGrow(ta); }
				});
			}
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void submit();
		}
	};

	const autoGrow = (el: HTMLTextAreaElement | null) => {
		if (!el) return;
		el.style.height = "auto";
		el.style.height = Math.min(el.scrollHeight, 140) + "px";
	};

	// Autogrow is a layout effect of the text, not part of render: resizing
	// here keeps typing decoupled from unrelated parent renders (streaming
	// deltas re-render the composer via context props, but the textarea only
	// touches the DOM when its own text changes).
	useEffect(() => {
		autoGrow(composerRef.current);
	}, [text]);

	return (
		<div
			className={`composer-dock w-full shrink-0 overflow-visible ${dragOver ? "is-dragging" : ""}`}
			onDragOver={(e) => {
				e.preventDefault();
				setDragOver(true);
			}}
			onDragLeave={(e) => {
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
				setDragOver(false);
			}}
			onDrop={(e) => {
				e.preventDefault();
				setDragOver(false);
				void addFiles(e.dataTransfer?.files ?? []);
			}}
		>
			<div ref={menuAnchorRef} className="relative w-full min-w-0">
				{ac.menuPortal}
				{streaming && (steering.length > 0 || followUp.length > 0) && (
					<div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
						{steering.map((s, i) => (
							<span key={`s${i}`} className="rounded-full bg-accent-soft px-2.5 py-1 font-medium text-accent">
								steer · {trunc(s)}
							</span>
						))}
						{followUp.map((s, i) => (
							<span key={`f${i}`} className="rounded-full bg-inset px-2.5 py-1 text-dim">
								queued · {trunc(s)}
							</span>
						))}
					</div>
				)}

				{attachmentError ? <p className="mb-2 text-[11px] text-err">{attachmentError}</p> : null}
				{attachments.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-2">
						{attachments.map((a, i) => {
							const isImage = a.mimeType.startsWith("image/");
							const isText = a.mimeType.startsWith("text/");
							return (
								<div key={i} className="group relative">
									{isImage ? (
										<img src={a.url} alt={a.name} title={a.name} className="h-14 w-14 rounded-xl border border-line object-cover" />
									) : (
										<div className="flex h-14 min-w-[120px] items-center gap-2 rounded-xl border border-line bg-inset px-3" title={a.name}>
											<span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-soft text-[length:var(--chat-r-10)] font-bold text-accent">{isText ? "TXT" : "FILE"}</span>
											<span className="min-w-0 flex-1 truncate text-[11px] font-medium">{a.name}</span>
											<span className="text-[length:var(--chat-r-11)] text-dim">{Math.round((a.data.length * 3) / 4 / 1024)}KB</span>
										</div>
									)}
									<button
										onClick={() =>
											setAttachments((list) => {
												URL.revokeObjectURL(list[i]?.url ?? "");
												return list.filter((_, j) => j !== i);
											})
										}
										aria-label={`Remove attachment ${a.name}`}
										className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-fg text-bg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
									>
										<XIcon size={9} />
									</button>
								</div>
							);
						})}
					</div>
				)}
				<div
					className={`composer-surface group relative flex flex-col ${designMode === "active" ? "is-design-mode" : ""}`}
				>
					{dialog !== undefined ? (
						<div role="dialog" aria-modal="true" aria-labelledby="composer-dialog-title" className="border-b border-line px-4 py-3">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0 flex-1">
									<p id="composer-dialog-title" className="text-[length:var(--chat-r-14)] font-semibold leading-snug tracking-tight break-words">{dialog.title ?? "Question"}</p>
									{dialog.message && <div className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line/60 bg-inset/40 px-3 py-2 text-[length:var(--chat-r-13)] leading-[1.6] text-dim">{dialog.message}</div>}
								</div>
								<button
									onClick={async () => {
										const id = dialog?.id;
												if (!id) return;
										onDialogDismiss?.(id);
										try {
											const { bridge: b } = await import("../bridge");
											await b.uiRespond({ id, cancelled: true });
										} catch {}
									}}
									className="shrink-0 rounded-md p-1 text-dim hover:bg-inset hover:text-fg"
									aria-label="Dismiss"
								>
									✕
								</button>
							</div>
							{dialog.method === "select" && Array.isArray(dialog.options) ? (
								<div className="mt-3 flex flex-col gap-1">
									{dialog.options.map((o: string, idx: number) => (
										<button
											key={`${o}-${idx}`}
											onClick={async () => {
												const id = dialog?.id;
												if (!id) return;
												onDialogDismiss?.(id);
												try {
													const { bridge: b } = await import("../bridge");
													await b.uiRespond({ id, value: dialogText.trim() || o });
												} catch (e) {
													toast?.("error", errorMessage(e, "failed"));
												}
											}}
											className="flex w-full items-center justify-between rounded-xl border border-line bg-bg px-3 py-2 text-left text-[12px] transition-colors hover:border-accent/30 hover:bg-accent/5 hover:text-accent"
										>
											<span className="flex items-center gap-2">
												<span className="grid h-5 w-5 place-items-center rounded-md bg-inset text-[length:var(--chat-r-11)] font-medium text-dim">{idx + 1}</span>
												{o}
											</span>
											<span className="text-[length:var(--chat-r-11)] text-dim">{idx + 1} ↩</span>
										</button>
									))}
									<div className="mt-1 flex items-center gap-2 border-t border-line/60 pt-2">
										<input
											value={dialogText}
											onChange={(e) => setDialogText(e.target.value)}
											onKeyDown={async (e) => {
												if (e.key !== "Enter") return;
												e.preventDefault();
												const custom = dialogText.trim();
												if (!custom) return;
												const id = dialog?.id;
												if (!id) return;
												onDialogDismiss?.(id);
												try {
													const { bridge: b } = await import("../bridge");
													await b.uiRespond({ id, value: custom });
												} catch (err) {
													toast?.("error", errorMessage(err, "failed"));
												}
											}}
											placeholder="Or type a custom answer…"
											aria-label="Custom answer"
											className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[12px] outline-none focus:border-accent"
										/>
										<button
											onClick={async () => {
												const custom = dialogText.trim();
												if (!custom) return;
												const id = dialog?.id;
												if (!id) return;
												onDialogDismiss?.(id);
												try {
													const { bridge: b } = await import("../bridge");
													await b.uiRespond({ id, value: custom });
												} catch (err) {
													toast?.("error", errorMessage(err, "failed"));
												}
											}}
											disabled={!dialogText.trim()}
											className="shrink-0 rounded-lg bg-fg px-3 py-2 text-[12px] font-semibold text-bg disabled:opacity-30"
										>
											Send
										</button>
									</div>
								</div>
							) : dialog.method === "input" || dialog.method === "editor" ? (
								<ComposerDialogInput dialog={dialog} onDismiss={onDialogDismiss!} toast={toast} />
							) : null}
							<p className="mt-2 text-[length:var(--chat-r-11)] text-dim">Press 1,{Math.min(9, dialog.options?.length ?? 0)} to choose, type a custom answer, or Esc to dismiss.</p>
						</div>
					) : null}

					{!hasBlockingDialog && (
						<div className="flex items-center gap-3 px-4 py-3">
							<input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files ?? []); e.target.value = ""; }} />
							<button onClick={() => fileRef.current?.click()} title="Attach (paste / drag & drop)" aria-label="Attach file" disabled={hasBlockingDialog} className="composer-pressable grid h-8 w-8 shrink-0 place-items-center text-dim hover:text-fg disabled:opacity-40"><PaperclipIcon size={16} /></button>
						<span className="relative shrink-0">
							<button
								onClick={() => setStashOpen((o) => !o)}
								title="Stashed drafts (⌘S to stash)"
								aria-label={stash.length ? `Stashed drafts (${stash.length})` : "Stash draft"}
								aria-expanded={stashOpen}
								disabled={hasBlockingDialog}
								className="composer-pressable grid h-8 w-8 place-items-center rounded-md text-dim hover:text-fg disabled:opacity-40"
							>
								<BookmarkIcon size={15} />
								{stash.length > 0 ? (
									<span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-white">{stash.length}</span>
								) : null}
							</button>
							{stashOpen && stash.length > 0 ? (
								<div role="menu" aria-label="Stashed drafts" className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-line bg-bg shadow-xl">
									{stash.map((s) => (
										<div key={s.id} className="group flex items-center gap-2 border-b border-line/60 px-3 py-2 last:border-0 hover:bg-inset">
											<button
												role="menuitem"
												onClick={() => {
													setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${s.text}` : s.text));
													setStash((list) => list.filter((x) => x.id !== s.id));
													setStashOpen(false);
													requestAnimationFrame(() => composerRef.current?.focus());
												}}
												title="Restore into composer"
												className="min-w-0 flex-1 truncate text-left text-[12px] text-fg"
											>
												{s.text.length > 80 ? `${s.text.slice(0, 80)}…` : s.text}
											</button>
											<button
												onClick={() => setStash((list) => list.filter((x) => x.id !== s.id))}
												aria-label="Delete stashed draft"
												className="shrink-0 rounded p-1 text-dim opacity-0 hover:text-err group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
											>
												✕
											</button>
										</div>
									))}
								</div>
							) : null}
						</span>
							<span className="shrink-0 select-none text-[length:var(--prompt-font)] leading-none text-dim" aria-hidden>&gt;</span>
							<textarea ref={composerRef} value={text} onChange={(e) => { setText(e.target.value); if (historyCursor !== null) setHistoryCursor(null); }} onKeyDown={onKeyDown} onPaste={onPaste} rows={1} disabled={hasBlockingDialog} placeholder={streaming ? (mode === "steer" ? "Steer…" : "Queue…") : "Message Pi…"} role="textbox" aria-label="Message Pi" aria-autocomplete="list" aria-controls={ac.openMenu?.id} aria-activedescendant={ac.openMenu ? `${ac.openMenu.optionIdPrefix}-${ac.openMenu.selected}` : undefined} className="composer-input max-h-[140px] min-h-[20px] w-full flex-1 resize-none border-0 bg-transparent py-1 text-[length:var(--prompt-font)] leading-[1.5] outline-none placeholder:text-dim focus:outline-none focus-visible:outline-none" />
							{streaming ? (
								<div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Delivery mode"><button onClick={() => setMode("steer")} aria-pressed={mode === "steer"} title="Interrupt and redirect" className={`composer-pressable h-8 rounded-md px-3 text-[12px] ${mode === "steer" ? "bg-accent text-white" : "bg-inset text-dim hover:text-fg"}`}>steer</button><button onClick={() => setMode("followUp")} aria-pressed={mode === "followUp"} title="Queue after current run" className={`composer-pressable h-8 rounded-md px-3 text-[12px] ${mode === "followUp" ? "bg-accent text-white" : "bg-inset text-dim hover:text-fg"}`}>queue</button><button onClick={onAbort} title="Stop run" aria-label="Stop run" className="composer-pressable grid h-8 w-8 place-items-center rounded-md bg-err text-white hover:bg-err/90"><StopIcon size={14} /></button></div>
							) : (
								<button onClick={submit} disabled={sending || (!text.trim() && attachments.length === 0)} title={sending ? "Sending…" : "Send"} aria-label="Send message" className="composer-pressable grid h-8 w-8 shrink-0 place-items-center rounded-full bg-fg text-bg hover:bg-fg/90 disabled:cursor-not-allowed disabled:opacity-30"><SendIcon size={14} /></button>
							)}
						</div>
					)}
					{/* Session control row, part of the composer surface (T3Code's
					    in-composer controls). Two groups: runtime config on the
					    left (permission, model, thinking), session state on the
					    right (Goal, Design, activity, usage). A pending Approve
					    is the one emphasized element, never another ghost. */}
					{!hasBlockingDialog && (
						<div className="composer-controls-row flex items-center gap-0.5 border-t border-line/60 px-3 py-1">
							<span className="flex shrink-0 items-center">
								<PermissionModePicker />
							</span>
							<span className="model-shrink flex min-w-0 max-w-[38%] shrink items-center">
								<ModelPicker
									models={models}
									current={agentState?.model ?? null}
									disabled={!models.length}
									onSelect={onSetModel}
								/>
							</span>
							<span className="flex shrink-0 items-center">
								<ThinkingPicker
									current={agentState?.thinkingLevel ?? "off"}
									available={thinkingLevels.length ? thinkingLevels : undefined}
									disabled={!agentState}
									onSelect={onSetThinking}
								/>
							</span>
							<div className="flex-1" />
							<span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-line/60" />
							{onToggleGoal ? (
								<span className="flex shrink-0 items-center">
									<button
										type="button"
										onClick={onToggleGoal}
										aria-pressed={goalMode !== "off"}
										disabled={designMode !== "off"}
										title={
											designMode !== "off"
												? "Goal is unavailable while Design is armed or active"
												: goalMode === "active"
													? `Pursuing: ${trunc(goalObjective || "goal", 80)} (click to stop)`
													: goalMode === "armed"
														? "Goal mode on. Your next message becomes the goal. (Click to disarm)"
														: "Goal mode: your next message becomes the goal"
										}
										className={`operator-meta-control composer-pressable ${goalMode !== "off" ? "text-fg underline underline-offset-2" : ""}`}
									>
										Goal{goalMode === "active" ? " ●" : ""}
									</button>
								</span>
							) : null}
						{onToggleDesign ? (
							<span className="relative flex shrink-0 items-center">
								<button
									type="button"
									onClick={() => {
										if (designMode === "active") setDesignMenuOpen((open) => !open);
										else onToggleDesign();
									}}
									aria-pressed={designMode !== "off"}
									aria-haspopup={designMode === "active" ? "menu" : undefined}
									aria-expanded={designMode === "active" ? designMenuOpen : undefined}
									disabled={goalMode !== "off"}
									title={
										goalMode !== "off"
											? "Design is unavailable while a Goal is armed or active"
											: designMode === "active"
												? `Design · ${designStageLabel(designStage)}${designSubject ? `: ${trunc(designSubject, 80)}` : ""}`
												: designMode === "armed"
													? "Design armed. Your next message starts the interview. (Click to disarm)"
													: "Design mode: your next message starts the design interview"
									}
									className={`operator-meta-control composer-pressable ${designMode !== "off" ? "text-fg underline underline-offset-2" : ""}`}
								>
									{designMode === "active" ? `Design · ${designStageLabel(designStage)}` : "Design"}
								</button>
								{designMode === "active" && designMenuOpen ? (
									<div
										role="menu"
										aria-label="Design session"
										className="operator-popover absolute bottom-full left-0 z-50 mb-1.5 w-52 p-1.5"
										onKeyDown={(e) => {
											if (e.key === "Escape") setDesignMenuOpen(false);
										}}
									>
										<button
											type="button"
											role="menuitem"
											onClick={() => {
												setDesignMenuOpen(false);
												onEndDesign?.();
											}}
											className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-inset"
										>
											End design
										</button>
										<button
											type="button"
											role="menuitem"
											onClick={() => {
												setDesignMenuOpen(false);
												onRestartDesign?.();
											}}
											className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-inset"
										>
											Restart
										</button>
									</div>
								) : null}
							</span>
						) : null}
						{designApproval ? (
							<span className="flex shrink-0 items-center">
								<button type="button" onClick={designApproval.onApprove} title="Approve and continue the design flow" className="composer-pressable composer-approve-enter rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-bg hover:bg-accent/90">{designApproval.label}</button>
							</span>
						) : null}
							{streaming && (
								<span className="flex shrink-0 items-center px-1">
									<ThroughputBars active />
								</span>
							)}
							<span className="flex shrink-0 items-center">
								<StatsPopover stats={stats ?? null} hasSession={!!agentState} onCompact={onCompact} />
							</span>
						</div>
					)}
				</div>

			</div>
		</div>
	);
});

function ComposerDialogInput({ dialog, onDismiss, toast }: { dialog: Dialog; onDismiss: (id: string) => void; toast: Props["toast"] }) {
	const [value, setValue] = useState(dialog.prefill ?? "");
	const respond = async (payload: Record<string, unknown>) => {
		onDismiss(dialog.id);
		try {
			const { bridge } = await import("../bridge");
			await bridge.uiRespond({ id: dialog.id, ...payload });
		} catch (e) {
			toast("error", errorMessage(e, "failed to answer"));
		}
	};
	return (
		<div className="mt-2 flex flex-col gap-2">
			{dialog.method === "input" ? (
				<input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={dialog.placeholder} onKeyDown={(e) => e.key === "Enter" && void respond({ value })} className="rounded-xl border border-line bg-bg px-3 py-2 text-[length:var(--chat-r-13)] outline-none focus:border-[var(--focus)]" />
			) : (
				<textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} rows={4} className="resize-y rounded-xl border border-line bg-bg px-3 py-2 font-mono text-[length:var(--code-font)] outline-none focus:border-[var(--focus)]" />
			)}
			<div className="flex justify-end gap-2">
				<button onClick={() => void respond({ cancelled: true })} className="rounded-full border border-line px-3 py-1.5 text-[12px]">Cancel</button>
				<button onClick={() => void respond({ value })} className="rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-white">Submit</button>
			</div>
		</div>
	);
}

export default Composer;
