import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommandInfo } from "../bridge";
import type { Bot } from "../bots";
import { botHandle, rankBots } from "../bots";
import { insertCommand } from "../commands";
import { rankCommandsEffect } from "../commands.effect";
import { expandSkillMentions, stripSkillPrefix } from "../lib/skillRef";
import { detectComposerTriggerEffect } from "../lib/composerTrigger.effect";
import * as Effect from "effect/Effect";
import { truncateEffect } from "../lib/string.effect";
import { collectComposerInlineTokensEffect } from "../lib/composerInlineTokens.effect";
import CommandMenu from "./CommandMenu";
import BotMentionMenu from "./BotMentionMenu";
import { PaperclipIcon, SendIcon, StopIcon, XIcon } from "./icons";

export interface Attachment {
	name: string;
	mimeType: string;
	data: string;
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
	/** Bots offered for @-mention completion (room members in rooms). */
	mentionBots?: Bot[];
}

function trunc(s: string, n = 42): string {
	const one = s.replace(/\s+/g, " ").trim();
	return Effect.runSync(truncateEffect(one, n));
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
	models,
	thinkingLevels,
	draftRequest,
	toast,
	onSend,
	onAbort,
	onSetModel,
	onSetThinking,
	onCompact,
	dialogs,
	onDialogDismiss,
	mentionBots = [],
}: Props) {
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"steer" | "followUp">("steer");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [dragOver, setDragOver] = useState(false);
	const [sending, setSending] = useState(false);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [selectedCommand, setSelectedCommand] = useState(0);
	const [dismissedToken, setDismissedToken] = useState<string | null>(null);
	const [history, setHistory] = useState<string[]>(() => {
		try { return JSON.parse(localStorage.getItem("babylon:composer-history") ?? "[]"); } catch { return []; }
	});
	const [historyCursor, setHistoryCursor] = useState<number | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const attachmentsRef = useRef<Attachment[]>([]);
	const trigger = useMemo(() => Effect.runSync(detectComposerTriggerEffect(text, text.length)), [text]);
	const _inlineTokens = useMemo(() => Effect.runSync(collectComposerInlineTokensEffect(text)), [text]);
	const commandToken = useMemo(() => {
		if (!trigger) return null;
		if (trigger.kind === "slash-command") return trigger.query;
		if (trigger.kind === "slash-model") return trigger.query || "model";
		return null;
	}, [trigger]);
	const commandMatches = useMemo(
		() =>
			commandToken !== null && commandToken !== dismissedToken
				? Effect.runSync(rankCommandsEffect(commands, commandToken, 16))
				: [],
		[commandToken, commands, dismissedToken]
	);

	// Bot @-mentions: the path trigger doubles as the mention token. Queries
	// containing "/" are file paths, never bot handles, bots stay out of the way.
	const [selectedMention, setSelectedMention] = useState(0);
	const [dismissedMention, setDismissedMention] = useState<string | null>(null);
	const mentionToken = useMemo(() => {
		if (!trigger || trigger.kind !== "path") return null;
		if (trigger.query.includes("/")) return null;
		return trigger;
	}, [trigger]);
	const mentionMatches = useMemo(
		() =>
			mentionToken && mentionToken.query !== dismissedMention && mentionBots.length
				? rankBots(mentionBots, mentionToken.query, 8)
				: [],
		[mentionToken, mentionBots, dismissedMention]
	);

	// Skill $-mentions: autocomplete over skill commands only (display names
	// stripped of the `skill:` prefix). Choosing, or typing, `$name` inserts
	// the sigil form; submit expands known names to canonical `/skill:name` so
	// the transcript carries just the invocation chip, never pasted content.
	const [selectedSkill, setSelectedSkill] = useState(0);
	const [dismissedSkill, setDismissedSkill] = useState<string | null>(null);
	const skillToken = useMemo(() => {
		if (!trigger || trigger.kind !== "skill") return null;
		return trigger;
	}, [trigger]);
	const skillCommands = useMemo(
		() => commands.filter((c) => c.source === "skill").map((c) => ({ ...c, name: stripSkillPrefix(c.name) })),
		[commands]
	);
	const skillMatches = useMemo(
		() =>
			skillToken && skillToken.query !== dismissedSkill
				? Effect.runSync(rankCommandsEffect(skillCommands, skillToken.query, 8))
				: [],
		[skillToken, skillCommands, dismissedSkill]
	);

	useEffect(() => setSelectedCommand(0), [commandToken]);
	useEffect(() => setSelectedMention(0), [mentionToken?.query]);
	useEffect(() => setSelectedSkill(0), [skillToken?.query]);
	// Composer popovers portal to document.body: the session footer (and the
	// sketch theme's overflow:hidden on it) would otherwise clip anything
	// opening upward. Fixed z-60 sits above chat content but below modal
	// surfaces (palette, popovers, toasts at z-70).
	const menuAnchorRef = useRef<HTMLDivElement>(null);
	const [, setMenuLayoutTick] = useState(0);
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
			if (f.size > MAX_IMAGE_BYTES) {
				rejected++;
				continue;
			}
			try {
				if (f.type.startsWith("image/")) {
					const viaWorker = await prepareImageViaWorker(f);
					const prepared = viaWorker ?? (await prepareImage(f));
					const data = await readAsBase64(prepared.blob);
					added.push({ name: f.name || "image", mimeType: prepared.mimeType, data, url: URL.createObjectURL(prepared.blob) });
				} else {
					const data = await readAsBase64(f);
					const url = URL.createObjectURL(f);
					added.push({ name: f.name || "file", mimeType: f.type || "application/octet-stream", data, url });
				}
			} catch {
				rejected++;
			}
		}
		if (added.length) {
			setAttachments((a) => [...a, ...added]);
			setAttachmentError(null);
		}
		if (rejected) setAttachmentError(`${rejected} file${rejected === 1 ? " was" : "s were"} not attached (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
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
		const fileAttachments = attachments.filter((a) => !a.mimeType.startsWith("image/"));
		let messageText = expandSkillMentions(t, skillCommands.map((c) => c.name));
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
				const isTextLike = f.mimeType.startsWith("text/") || f.mimeType === "application/json" || f.name.match(/\.(txt|md|json|csv|log|js|ts|tsx|py|sh|yaml|yml)$/i);
				if (isTextLike) return `[File: ${f.name}]\n${content}`;
				return `[File: ${f.name} (${f.mimeType}, ${Math.round((f.data.length * 3) / 4 / 1024)}KB)]`;
			}).join("\n\n");
			messageText = messageText ? `${messageText}\n\n${fileBlocks}` : fileBlocks;
		}
		const outgoing = imageAttachments;
		const isStreamingSubmit = streaming;
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

	const chooseSkill = (command: CommandInfo) => {
		if (!skillToken) return;
		const next = `${text.slice(0, skillToken.rangeStart)}$${command.name} ${text.slice(skillToken.rangeEnd)}`;
		setText(next);
		setDismissedSkill(null);
		requestAnimationFrame(() => {
			const textarea = composerRef.current;
			textarea?.focus();
			textarea?.setSelectionRange(next.length, next.length);
		});
	};

	const chooseMention = (bot: Bot) => {
		if (!mentionToken) return;
		const next = `${text.slice(0, mentionToken.rangeStart)}@${botHandle(bot)} ${text.slice(mentionToken.rangeEnd)}`;
		setText(next);
		setDismissedMention(null);
		requestAnimationFrame(() => {
			const textarea = composerRef.current;
			textarea?.focus();
			textarea?.setSelectionRange(next.length, next.length);
		});
	};

	const menusOpen = commandMatches.length > 0 || mentionMatches.length > 0 || skillMatches.length > 0;
	useEffect(() => {
		if (!menusOpen) return;
		const onResize = () => setMenuLayoutTick((n) => n + 1);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [menusOpen]);
	// Anchored above the composer; measured every render while open so textarea
	// autogrow keeps it glued. Portaled out of the session footer (see note above).
	const menuPortal = (() => {
		if (!menusOpen) return null;
		const rect = menuAnchorRef.current?.getBoundingClientRect();
		if (!rect) return null;
		return createPortal(
			<div
				style={{
					position: "fixed",
					left: rect.left,
					width: rect.width,
					bottom: Math.max(8, window.innerHeight - rect.top + 8),
					zIndex: 60,
				}}
			>
				<CommandMenu commands={commandMatches} selected={selectedCommand} onSelect={setSelectedCommand} onChoose={chooseCommand} />
				<BotMentionMenu bots={mentionMatches} selected={selectedMention} onSelect={setSelectedMention} onChoose={chooseMention} />
				<CommandMenu commands={skillMatches} selected={selectedSkill} onSelect={setSelectedSkill} onChoose={chooseSkill} sigil="$" listId="composer-skills" optionIdPrefix="skill-opt" label="Skills" />
			</div>,
			document.body
		);
	})();

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
		const menuOpen = commandMatches.length > 0 || mentionMatches.length > 0 || skillMatches.length > 0;
		if (mentionMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			e.preventDefault();
			setSelectedMention((index) => (e.key === "ArrowDown" ? (index + 1) % mentionMatches.length : (index - 1 + mentionMatches.length) % mentionMatches.length));
			return;
		}
		if (commandMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			e.preventDefault();
			setSelectedCommand((index) => (e.key === "ArrowDown" ? (index + 1) % commandMatches.length : (index - 1 + commandMatches.length) % commandMatches.length));
			return;
		}
		if (skillMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			e.preventDefault();
			setSelectedSkill((index) => (e.key === "ArrowDown" ? (index + 1) % skillMatches.length : (index - 1 + skillMatches.length) % skillMatches.length));
			return;
		}
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
		if (mentionMatches.length && e.key === "Escape") {
			e.preventDefault();
			setDismissedMention(mentionToken?.query ?? "");
			return;
		}
		if (commandMatches.length && e.key === "Escape") {
			e.preventDefault();
			setDismissedToken(commandToken);
			return;
		}
		if (skillMatches.length && e.key === "Escape") {
			e.preventDefault();
			setDismissedSkill(skillToken?.query ?? "");
			return;
		}
		if (mentionMatches.length && e.key === "Tab") {
			e.preventDefault();
			chooseMention(mentionMatches[selectedMention] ?? mentionMatches[0]);
			return;
		}
		if (commandMatches.length && e.key === "Tab") {
			e.preventDefault();
			chooseCommand(commandMatches[selectedCommand] ?? commandMatches[0]);
			return;
		}
		if (skillMatches.length && e.key === "Tab") {
			e.preventDefault();
			chooseSkill(skillMatches[selectedSkill] ?? skillMatches[0]);
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			if (mentionMatches.length) {
				const selected = mentionMatches[selectedMention] ?? mentionMatches[0];
				if (selected && mentionToken && `@${botHandle(selected)}` !== `@${mentionToken.query}`) chooseMention(selected);
				else void submit();
				return;
			}
			if (skillMatches.length) {
				const selected = skillMatches[selectedSkill] ?? skillMatches[0];
				if (selected && skillToken && `$${selected.name}` !== `$${skillToken.query}`) chooseSkill(selected);
				else void submit();
				return;
			}
			const selected = commandMatches[selectedCommand] ?? commandMatches[0];
			if (selected && commandToken !== selected.name) chooseCommand(selected);
			else void submit();
		}
	};

	const autoGrow = (el: HTMLTextAreaElement | null) => {
		if (!el) return;
		el.style.height = "auto";
		el.style.height = Math.min(el.scrollHeight, 140) + "px";
	};

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
				{menuPortal}
				{streaming && (steering.length > 0 || followUp.length > 0) && (
					<div className="mb-2 flex flex-wrap gap-1.5 text-[12px]">
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

				{attachmentError ? <p className="mb-2 text-[12px] text-err">{attachmentError}</p> : null}
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
											<span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-soft text-[10px] font-bold text-accent">{isText ? "TXT" : "FILE"}</span>
											<span className="min-w-0 flex-1 truncate text-[12px] font-medium">{a.name}</span>
											<span className="text-[11px] text-dim">{Math.round((a.data.length * 3) / 4 / 1024)}KB</span>
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
					className={`composer-surface !border-0 !shadow-none group relative flex flex-col border-0 bg-transparent font-mono text-[15px] !outline-none focus-within:!border-0 focus-within:!shadow-none focus-within:!outline-none ${dragOver ? "bg-accent/[0.04]" : ""}`}
					style={{ border: "none", boxShadow: "none", outline: "none" }}
				>
					{dialogs?.[0] ? (
						<div role="dialog" aria-modal="true" aria-labelledby="composer-dialog-title" className="border-b border-line px-4 py-3">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0 flex-1">
									<p id="composer-dialog-title" className="text-[13.5px] font-semibold leading-snug tracking-tight break-words">{dialogs[0].title ?? "Question"}</p>
									{dialogs[0].message && <div className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line/60 bg-inset/40 px-3 py-2 text-[12.5px] leading-[1.6] text-dim">{dialogs[0].message}</div>}
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
									aria-label="Dismiss"
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
											className="flex w-full items-center justify-between rounded-xl border border-line bg-bg px-3 py-2 text-left text-[13px] transition-colors hover:border-accent/30 hover:bg-accent/5 hover:text-accent"
										>
											<span className="flex items-center gap-2">
												<span className="grid h-5 w-5 place-items-center rounded-md bg-inset text-[11px] font-medium text-dim">{idx + 1}</span>
												{o}
											</span>
											<span className="text-[11px] text-dim">{idx + 1} ↩</span>
										</button>
									))}
								</div>
							) : dialogs[0].method === "input" || dialogs[0].method === "editor" ? (
								<ComposerDialogInput dialog={dialogs[0]} onDismiss={onDialogDismiss!} toast={toast} />
							) : null}
							<p className="mt-2 text-[11px] text-dim">Press 1,{Math.min(9, dialogs[0].options?.length ?? 0)} to choose, or Esc to dismiss.</p>
						</div>
					) : null}

					{!hasBlockingDialog && (
						<div className="flex items-center gap-3 px-3 py-3">
							<input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files ?? []); e.target.value = ""; }} />
							<button onClick={() => fileRef.current?.click()} title="Attach (paste / drag & drop)" aria-label="Attach file" disabled={hasBlockingDialog} className="grid h-8 w-8 shrink-0 place-items-center text-dim hover:text-fg disabled:opacity-40"><PaperclipIcon size={16} /></button>
							<span className="shrink-0 select-none font-mono text-[15px] leading-none text-dim" aria-hidden>&gt;</span>
							<textarea ref={(el) => { (composerRef as any).current = el; if (el) autoGrow(el); }} value={text} onChange={(e) => { setText(e.target.value); if (historyCursor !== null) setHistoryCursor(null); autoGrow(e.target as HTMLTextAreaElement); }} onKeyDown={onKeyDown} onPaste={onPaste} rows={1} disabled={hasBlockingDialog} placeholder={streaming ? (mode === "steer" ? "Steer…" : "Queue…") : "Ask anything…"} role="combobox" aria-label="Message Pi" aria-autocomplete="list" aria-expanded={commandMatches.length > 0 || mentionMatches.length > 0 || skillMatches.length > 0} aria-controls={commandMatches.length > 0 ? "composer-commands" : mentionMatches.length > 0 ? "composer-bot-mentions" : skillMatches.length > 0 ? "composer-skills" : undefined} aria-activedescendant={commandMatches.length > 0 ? `cmd-opt-${selectedCommand}` : mentionMatches.length > 0 ? `mention-opt-${selectedMention}` : skillMatches.length > 0 ? `skill-opt-${selectedSkill}` : undefined} className="composer-input max-h-[140px] min-h-[20px] w-full flex-1 resize-none border-0 bg-transparent py-1 font-mono text-[15px] leading-6 !outline-none placeholder:text-dim/40 focus:!outline-none focus-visible:!outline-none focus:!ring-0 focus-visible:!ring-0" style={{ outline: "none", boxShadow: "none", border: "none" } as any} />
							{streaming ? (
								<div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="Delivery mode"><button onClick={() => setMode("steer")} aria-pressed={mode === "steer"} title="Interrupt and redirect" className={`h-8 px-3 font-mono text-[13px] ${mode === "steer" ? "bg-accent text-white" : "bg-inset text-dim hover:text-fg"}`}>steer</button><button onClick={() => setMode("followUp")} aria-pressed={mode === "followUp"} title="Queue after current run" className={`h-8 px-3 font-mono text-[13px] ${mode === "followUp" ? "bg-accent text-white" : "bg-inset text-dim hover:text-fg"}`}>queue</button><button onClick={onAbort} title="Stop run" aria-label="Stop run" className="grid h-8 w-8 place-items-center bg-err text-white hover:bg-err/90"><StopIcon size={14} /></button></div>
							) : (
								<button onClick={submit} disabled={sending || (!text.trim() && attachments.length === 0)} title={sending ? "Sending…" : "Send"} aria-label="Send message" className="grid h-8 w-8 shrink-0 place-items-center bg-fg text-bg hover:bg-fg/90 disabled:cursor-not-allowed disabled:opacity-30"><SendIcon size={14} /></button>
							)}
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
				<input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={dialog.placeholder} onKeyDown={(e) => e.key === "Enter" && void respond({ value })} className="rounded-xl border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-[var(--focus)]" />
			) : (
				<textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} rows={4} className="resize-y rounded-xl border border-line bg-bg px-3 py-2 font-mono text-[12px] outline-none focus:border-[var(--focus)]" />
			)}
			<div className="flex justify-end gap-2">
				<button onClick={() => void respond({ cancelled: true })} className="rounded-full border border-line px-3 py-1.5 text-[12.5px]">Cancel</button>
				<button onClick={() => void respond({ value })} className="rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-semibold text-white">Submit</button>
			</div>
		</div>
	);
}

export default Composer;
