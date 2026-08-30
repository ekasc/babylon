// Snapcompact Pi extension: wires the snapcompact pipeline into Pi's
// real compaction boundary (`session_before_compact`) and the
// transient context projection event (`context`).
//
// Architecture (per the review):
//   - Default `compaction.mode = "summary"` does zero snapcompact work.
//     The extension's gate returns no custom compaction and does not
//     subscribe to context events for the projection.
//   - For `automatic` / `snapcompact` modes the extension:
//       1. On `session_before_compact`, runs the single strategy decision.
//          - `summary` -> no custom compaction; Pi performs its normal
//            textual compaction.
//          - `snapcompact` -> requires image capability; builds the
//            archive from preparation.messagesToSummarize +
//            preparation.turnPrefixMessages; persists it; returns
//            { summary: <deterministic marker>, firstKeptEntryId,
//            tokensBefore, details: { snapcompactGeneration } }.
//            On any failure -> no custom compaction (Pi falls back).
//       2. On `context` (before every LLM call), the rebuilt messages
//          are scanned for a snapcompact marker. If the active
//          archive matches the current session and generation, the
//          messages array is replaced with a transient projection:
//          archive header + dictionary + images, prepended. Canonical
//          user messages are not modified; the projection is a
//          context-time transformation that Pi discards.
//
// This module exposes a factory that builds a minimal Pi Extension
// object whose `handlers` map is read by Pi's ExtensionRunner. The
// Babylon host installs it via `resourceLoaderOptions.extensionsOverride`
// so it runs on every session without Babylon holding a direct
// reference to the runner.

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { CompactionResult, Extension, SourceInfo } from "@earendil-works/pi-coding-agent";
import { buildArchive, ArchiveBudgetError } from "./build";
import { modelSupportsImages, profileForModel } from "./model-profiles";
import { pickStrategy } from "./strategy";
import { ArchiveStore, ArchiveIntegrityError } from "./archive-store";
import type { SnapcompactArchive } from "./types";
import { applySubstitution } from "./renderer";

// Structural image content sent to Pi's context event. Kept local to
// avoid depending on @earendil-works/pi-ai (a transitive of
// pi-coding-agent). Pi reads it structurally.
interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** Structural subset of Pi's CompactionPreparation that the snapcompact
 *  extension reads. CompactionPreparation is not re-exported from the
 *  pi-coding-agent public entry, so we describe the shape we need. */
interface SnapcompactCompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: any[];
  turnPrefixMessages: any[];
  tokensBefore: number;
}

export interface SnapcompactExtensionOptions {
  archiveStore: ArchiveStore;
  /** Read the user-selected compaction mode. */
  getMode: () => "automatic" | "summary" | "snapcompact";
  /** Read the active model (Babylon's runtime facade). */
  getModel: () => { provider?: string; id?: string; input?: string[] } | null | undefined;
  /** Read the active session id (from Pi's session). */
  getSessionId: () => string;
  /** Read the active session file path (from Pi's session). */
  getSessionFile?: () => string | null;
}

interface SnapcompactMarker {
  type: "compaction";
  fromHook: true;
  details: {
    snapcompactGeneration: string;
    sourceText: string;
    firstKeptEntryId: string | null;
    lastKeptEntryId: string | null;
    keptCount: number;
    omittedTrailing: SnapcompactArchive["omittedTrailing"];
  };
}

function isMarker(m: any): m is SnapcompactMarker {
  // Pi's CompactionEntry has type "compaction" and (for our extension)
  // details.snapcompactGeneration plus fromHook === true. We avoid
  // matching Pi's own textual compactions.
  return m && m.type === "compaction" && m.fromHook === true && !!(m.details && typeof m.details.snapcompactGeneration === "string");
}

function buildMarker(archive: SnapcompactArchive, summary: string): any {
  return {
    type: "compaction",
    summary,
    firstKeptEntryId: archive.firstKeptEntryId ?? archive.lastKeptEntryId ?? "",
    tokensBefore: 0,
    fromHook: true,
    details: {
      snapcompactGeneration: archive.compactionGenerationId,
      sourceText: archive.sourceText,
      firstKeptEntryId: archive.firstKeptEntryId,
      lastKeptEntryId: archive.lastKeptEntryId,
      keptCount: archive.keptCount,
      omittedTrailing: archive.omittedTrailing,
    },
  };
}

function buildProjectionMessages(archive: SnapcompactArchive, profile: { imageTokenEstimate: number; id: string }): { messages: any[]; dictionaryText: string } {
  // Render dictionary as raw text so OCR cannot corrupt the long
  // values. The exact-token dictionary is the contract: a coding
  // agent must be able to retrieve every path, SHA, version, port,
  // command, env, branch, and identifier verbatim.
  const symbols = archive.symbols;
  const dictionaryText = symbols.length
    ? symbols.map((s) => `${s.id}=${s.value}`).join("\n")
    : "(no symbols)";
  const head = archive.sourceText.length > 1200 ? archive.sourceText.slice(0, 1200) : archive.sourceText;
  const tailStart = Math.max(0, archive.sourceText.length - 1200);
  const tail = archive.sourceText.length > 1200 ? archive.sourceText.slice(tailStart) : "";
  const header = [
    "[Snapcompact archive] generation=" + archive.compactionGenerationId,
    "profile=" + profile.id,
    "frames=" + archive.frames.length,
    "imageTokens~=" + (archive.frames.length * profile.imageTokenEstimate),
    "bytes=" + archive.frameBytes,
    "--- archive head ---",
    head,
    "--- archive tail ---",
    tail || "(empty)",
    "--- exact-token dictionary ---",
    dictionaryText,
    "--- end snapcompact ---",
    "",
  ].join("\n");
  const substitutedHeader = {
    role: "user",
    content: [{ type: "text", text: applySubstitution(header, symbols) }],
  };
  // Images: base64 PNGs as real ImageContent (same normalization
  // contract Babylon uses for normal image prompts).
  const images: PiImageContent[] = archive.frames.map((f) => ({
    type: "image",
    data: f.png.toString("base64"),
    mimeType: "image/png",
  }));
  const imagesMessage = {
    role: "user",
    content: images,
  };
  return { messages: [substitutedHeader, imagesMessage], dictionaryText };
}

interface ExtensionHandlerCtx {
  abort(signal?: AbortSignal): void;
  hasUI(): boolean;
  getUIContext(): unknown;
  cwd: string;
  modelRegistry: unknown;
  sessionManager: unknown;
}

export interface SnapcompactExtensionHandle {
  ext: Extension;
}

function buildMinimalExtension(): Extension {
  // Pi's DefaultResourceLoader.getDefaultSourceInfoForPath short-circuits
  // any path wrapped in `<...>` with a default temporary source info,
  // which is what we want for an inline extension that has no real
  // filesystem backing.
  const sourceInfo: SourceInfo = { kind: "inline", identifier: "snapcompact" } as any;
  return {
    path: "<snapcompact-inline>",
    resolvedPath: "<snapcompact-inline>",
    hidden: true,
    sourceInfo,
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  } as Extension;
}

/** Build the snapcompact extension. The returned object is shaped so
 *  ExtensionRunner reads its `handlers` map for each event. */
export function createSnapcompactExtension(opts: SnapcompactExtensionOptions): Extension {
  const ext = buildMinimalExtension();
  const lastSeen = new Map<string, string>(); // sessionId -> last compactionGenerationId we built

  ext.handlers.set("session_before_compact", [
    async (event: any, _ctx: any) => {
      const preparation: SnapcompactCompactionPreparation = event.preparation;
      const sessionId = opts.getSessionId();
      const mode = opts.getMode();
      const model = opts.getModel();
      // Default summary mode does no work.
      if (mode === "summary") return undefined;
      // The build path: the same gates as pickStrategy, minus the
      // "archive exists" check (we are about to build it).
      if (!model) return undefined;
      if (!modelSupportsImages(model)) return undefined;
      const profile = profileForModel(model);
      // Build from exactly preparation.messagesToSummarize + turnPrefixMessages.
      const messages = [...(preparation.turnPrefixMessages ?? []), ...(preparation.messagesToSummarize ?? [])];
      if (!messages.length) return undefined;
      let result;
      try {
        result = buildArchive({ sessionId, sessionFile: deriveSessionFile(opts), messages, profile });
      } catch (err) {
        if (err instanceof ArchiveBudgetError) return undefined;
        throw err;
      }
      try {
        await opts.archiveStore.write(deriveSessionFile(opts), result.archive);
      } catch (err) {
        if (err instanceof ArchiveIntegrityError) return undefined;
        // Other I/O errors -> fall back.
        return undefined;
      }
      lastSeen.set(sessionId, result.archive.compactionGenerationId);
      const summary = `Recap: snapcompact archive generation=${result.archive.compactionGenerationId} frames=${result.archive.frames.length}`;
      const compaction: CompactionResult = {
        summary,
        // Pi's cut point is authoritative: the compaction entry must
        // reference the same first-kept entry Pi prepared, or the
        // session tree would keep entries the archive omits (or vice
        // versa). The archive's own coverage fields
        // (firstKeptEntryId/omittedTrailing) describe what the
        // archive contains and live in its manifest, not here.
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { snapcompactGeneration: result.archive.compactionGenerationId, snapcompactProfile: result.archive.profileId } as any,
      };
      return { compaction };
    },
  ]);

  ext.handlers.set("context", [
    async (event: any, _ctx: any) => {
      const mode = opts.getMode();
      if (mode === "summary") return undefined;
      // Find the most recent snapcompact marker among the rebuilt
      // messages. Pi's own context rebuild may place a CompactionEntry
      // there when the previous compaction emitted our marker.
      let marker: SnapcompactMarker | null = null;
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const m: any = event.messages[i];
        if (isMarker(m)) { marker = m; break; }
      }
      if (!marker) return undefined;
      const sessionId = opts.getSessionId();
      const sessionFile = deriveSessionFile(opts);
      const archive = await opts.archiveStore.load(sessionFile).catch((err) => {
        if (err instanceof ArchiveIntegrityError) return null;
        return null;
      });
      if (!archive) return undefined;
      if (archive.sessionId !== sessionId) return undefined;
      if (archive.compactionGenerationId !== marker.details.snapcompactGeneration) return undefined;
      if (archive.version !== 1) return undefined;
      if (archive.frames.length === 0) return undefined;
      const profile = profileForModel(opts.getModel());
      const { messages: projection, dictionaryText } = buildProjectionMessages(archive, profile);
      // The replacement MUST keep all original canonical messages in
      // order. Pi calls this event for every LLM request; the rebuilt
      // messages are the model's context. We replace the array with
      // the original messages + our transient projection. Canonical
      // session records (the user message "hello") are NOT mutated;
      // this returns a new array.
      const rebuilt = [...event.messages, ...projection];
      // Sanity: dictionary text matches the archive's symbols count.
      const expectedDictLines = archive.symbols.length;
      if (dictionaryText.split("\n").filter(Boolean).length !== expectedDictLines) {
        // Should be one line per symbol. If the projection drifted,
        // fall back to the unmodified rebuilt messages.
        return { messages: event.messages };
      }
      return { messages: rebuilt };
    },
  ]);

  return ext;
}

/** Resolve the session file path. The extension does not have direct
 *  access to the Pi session; the host injects a getter. If the host
 *  does not provide one, we fall back to deriving a stable path from
 *  the session id. */
function deriveSessionFile(opts: SnapcompactExtensionOptions): string {
  const f = (opts as any).getSessionFile?.();
  if (typeof f === "string" && f) return f;
  return `session://${opts.getSessionId()}`;
}
