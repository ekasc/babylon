// Snapcompact Pi extension: wires the snapcompact pipeline into Pi's
// real compaction boundary (`session_before_compact`) and the
// transient context projection event (`context`).

import { randomUUID } from "node:crypto";
import type { CompactionResult, Extension, SourceInfo } from "@earendil-works/pi-coding-agent";
import { buildArchive, ArchiveBudgetError } from "./build";
import { modelSupportsImages, profileForModel } from "./model-profiles";
import { pickStrategy } from "./strategy";
import { ArchiveStore, ArchiveIntegrityError } from "./archive-store";
import type { SnapcompactArchive } from "./types";
import { applySubstitution } from "./renderer";

interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface SnapcompactCompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: any[];
  turnPrefixMessages: any[];
  tokensBefore: number;
}

export interface SnapcompactExtensionOptions {
  archiveStore: ArchiveStore;
  getMode: () => "automatic" | "summary" | "snapcompact";
  getModel: () => { provider?: string; id?: string; input?: string[] } | null | undefined;
  getSessionId: () => string;
  getSessionFile?: () => string | null;
}

function buildProjectionMessages(archive: SnapcompactArchive, profile: { imageTokenEstimate: number; id: string }): { messages: any[]; dictionaryText: string } {
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

function buildMinimalExtension(): Extension {
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

function deriveSessionFile(opts: SnapcompactExtensionOptions): string {
  const f = (opts as any).getSessionFile?.();
  if (typeof f === "string" && f) return f;
  return `session://${opts.getSessionId()}`;
}

function findSnapcompactCompactionEntry(sessionManager: any): any | null {
  if (!sessionManager) return null;
  try {
    // Only the active branch matters. buildContextEntries returns
    // exactly the entries Pi considers for the current LLM context
    // (compaction-aware, branch-following). Never fall back to
    // getEntries() which scans all branches and would contaminate
    // branch B with branch A's archive.
    const entries: any[] = typeof sessionManager.buildContextEntries === "function"
      ? sessionManager.buildContextEntries()
      : [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "compaction" && e.fromHook === true && e.details?.snapcompactGeneration) {
        return e;
      }
    }
  } catch { /* fall through */ }
  return null;
}

export function createSnapcompactExtension(opts: SnapcompactExtensionOptions): Extension {
  const ext = buildMinimalExtension();
  let pendingFirstKeptReparentId: string | null = null;

  ext.handlers.set("session_before_compact", [
    async (event: any, ctx: any) => {
      const preparation: SnapcompactCompactionPreparation = event.preparation;
      const model = opts.getModel();
      const mode = opts.getMode();
      const hasMessages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])].length > 0;
      const decision = pickStrategy({
        model,
        mode,
        archive: null,
        archiveProducible: !!model && modelSupportsImages(model) && hasMessages,
        archiveMatchesSession: true,
        forBuild: true,
      });
      if (decision.strategy !== "snapcompact") return undefined;
      const profile = profileForModel(model);
      const messages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
      if (!messages.length) return undefined;
      // Cumulative rollover: if the active branch already has a previous
      // snapcompact generation, compose its normalized source with the newly
      // discarded messages so history is not lost. Use the session manager's
      // active branch, not a cross-branch scan.
      let previousArchive: SnapcompactArchive | null = null;
      try {
        const prevEntry = findSnapcompactCompactionEntry(ctx?.sessionManager);
        if (prevEntry?.details?.snapcompactGeneration) {
          const prevGen = String(prevEntry.details.snapcompactGeneration);
          previousArchive = await opts.archiveStore.loadGeneration(deriveSessionFile(opts), prevGen).catch(() => null)
            ?? await opts.archiveStore.load(deriveSessionFile(opts)).catch(() => null);
          if (previousArchive && previousArchive.compactionGenerationId !== prevGen) previousArchive = null;
        }
      } catch { /* ignore, treat as first compaction */ }
      let result;
      try {
        // Concrete fix for "entire session" expectation: the first snapcompact
        // after enabling must archive the whole history, not just the 60k most-
        // recent of the older part. Use a large budget and keep only the last
        // ~10 turns verbatim, so 1000+ older tool results don't get dropped as
        // `omittedTrailing:total-budget`.
        const isFirstSnapcompact = !previousArchive;
        const buildProfile = { ...profile, maxSourceChars: 20_000_000 };
        const getActiveEntries = (sm: any): any[] => {
          try {
            if (sm?.buildContextEntries) return sm.buildContextEntries();
            if (sm?.getBranch) return sm.getBranch();
            if (sm?.getEntries) return sm.getEntries();
          } catch {}
          return [];
        };
        const buildMessages = (() => {
          // For the very first generation, expand messages to the entire
          // active branch history up to firstKept, not just preparation's
          // slice, and force firstKept to keep only ~10 recent turns as
          // verbatim. Active branch only — never getEntries() which scans
          // all branches and would contaminate branch B with branch A's
          // history.
          try {
            const sm: any = (ctx as any)?.sessionManager;
            const all: any[] = getActiveEntries(sm);
            // Find firstKept index and keep only last 10 messages as recent
            const firstKeptIdx = all.findIndex((e: any) => e?.id === preparation.firstKeptEntryId);
            if (firstKeptIdx > 10) {
              const keepFrom = Math.max(0, all.length - 10);
              const toArchive = all.slice(0, keepFrom).map((e: any) => e?.message).filter(Boolean);
              if (toArchive.length > messages.length) return toArchive;
            }
          } catch {}
          return messages;
        })();
        const effectiveFirstKept = (() => {
          try {
            const sm: any = (ctx as any)?.sessionManager;
            const all: any[] = getActiveEntries(sm);
            if (all.length > 10) return all[all.length - 10].id ?? preparation.firstKeptEntryId;
          } catch {}
          return preparation.firstKeptEntryId;
        })();
        if (isFirstSnapcompact && effectiveFirstKept !== preparation.firstKeptEntryId) {
          pendingFirstKeptReparentId = effectiveFirstKept;
        } else {
          pendingFirstKeptReparentId = null;
        }
        // Patch preparation for this one build so the resulting compaction's
        // firstKept keeps only ~10 recent, archiving the rest.
        const originalFirstKept = preparation.firstKeptEntryId;
        (preparation as any).firstKeptEntryId = effectiveFirstKept;
        try {
          result = buildArchive({ sessionId: opts.getSessionId(), sessionFile: deriveSessionFile(opts), messages: buildMessages, profile: buildProfile, previousArchive });
        } finally {
          (preparation as any).firstKeptEntryId = originalFirstKept;
        }
      } catch (err) {
        if (err instanceof ArchiveBudgetError) return undefined;
        throw err;
      }
      // Collect referenced generations from session so GC never deletes
      // a generation still reachable on another branch.
      let referenced: Set<string> | undefined;
      try {
        const sm = ctx?.sessionManager;
        if (sm?.getEntries) {
          referenced = new Set(
            (sm.getEntries() as any[])
              .filter((e: any) => e?.type === "compaction" && e.details?.snapcompactGeneration)
              .map((e: any) => String(e.details.snapcompactGeneration))
          );
        }
      } catch { /* ignore */ }
      try {
        await opts.archiveStore.write(deriveSessionFile(opts), result.archive, referenced ? { referencedGenerationIds: referenced } : undefined);
      } catch (err) {
        if (err instanceof ArchiveIntegrityError) return undefined;
        return undefined;
      }
      const boundedFallback = (result.archive.textFallback ?? "").slice(0, 4000);
      const summary = `[Snapcompact generation=${result.archive.compactionGenerationId}]\n${boundedFallback}`;
      const compaction: CompactionResult = {
        summary,
        firstKeptEntryId: pendingFirstKeptReparentId ?? preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { snapcompactGeneration: result.archive.compactionGenerationId, snapcompactProfile: result.archive.profileId } as any,
      };
      return { compaction };
    },
  ]);

  ext.handlers.set("session_compact", [
    async (event: any, _ctx: any) => {
      // No direct SessionManager mutation. The active branch already
      // contains firstKept as an ancestor of the compaction (appendCompaction
      // makes the compaction a child of the previous leaf), so
      // buildContextEntries includes it without reparenting. Direct
      // parentId mutation would also risk connecting branches that should
      // remain independent and would not survive a SessionManager reload
      // without a file rewrite.
      if (pendingFirstKeptReparentId) pendingFirstKeptReparentId = null;
    },
  ]);

  ext.handlers.set("context", [
    async (event: any, ctx: any) => {
      const mode = opts.getMode();
      const model = opts.getModel();
      // Single owner for projection as well: delegate to pickStrategy.
      // We need an archive handle to call it properly, so first
      // resolve the active snapcompact compaction entry from the
      // session manager (not from event.messages, which contains
      // CompactionSummaryMessage with role:"compactionSummary" and no
      // details).
      const sessionManager = ctx?.sessionManager;
      const entry = findSnapcompactCompactionEntry(sessionManager);
      if (!entry) return undefined;
      const generationId = String(entry.details.snapcompactGeneration);
      const sessionFile = deriveSessionFile(opts);
      const sessionId = opts.getSessionId();
      // Try generation-addressable load first (branch-safe), fallback
      // to active manifest for backwards compat.
      let archive: SnapcompactArchive | null = null;
      try {
        archive = await opts.archiveStore.loadGeneration(sessionFile, generationId);
      } catch (err: any) {
        if (err instanceof ArchiveIntegrityError) return undefined;
        return undefined;
      }
      if (!archive) {
        try { archive = await opts.archiveStore.load(sessionFile); } catch { return undefined; }
        if (!archive || archive.compactionGenerationId !== generationId) return undefined;
      }
      if (archive.sessionId !== sessionId) return undefined;
      if (archive.version !== 1) return undefined;
      if (archive.frames.length === 0) return undefined;
      const fb = (archive as any).textFallback as string | undefined;
      const markerIndex = event.messages.findIndex(
        (m: any) => m?.role === "compactionSummary" && m?.summary === entry.summary,
      );
      console.log(`[snapcompact] context: markerIndex=${markerIndex} eventMessages=${event.messages.length} entrySummary=${entry.summary.slice(0,60)} fbLen=${fb?.length}`);
      if (markerIndex < 0) {
        console.log(`[snapcompact] context: marker not found, event first 3:`, event.messages.slice(0,3).map((m:any)=>({role:m.role, summary:m.summary?.slice(0,30)})));
        return undefined;
      }
      const before = event.messages.slice(0, markerIndex);
      const after = event.messages.slice(markerIndex + 1);
      // If the active branch was compacted with Snapcompact, the durable
      // history is in the archive. Switching mode to "summary" or
      // switching to a text-only model must not make that history vanish
      // (Pi's durable summary is just "Recap: generation=..."). In
      // those cases inject the stored textFallback at the marker
      // position instead of PNGs.
      if (mode === "summary") {
        if (!fb) return undefined;
        return { messages: [...before, { role: "user", content: [{ type: "text", text: fb }] }, ...after] };
      }
      if (!modelSupportsImages(model)) {
        if (!fb) return undefined;
        return { messages: [...before, { role: "user", content: [{ type: "text", text: fb }] }, ...after] };
      }
      console.log(`[snapcompact] context: found entry ${generationId} archive=${archive.compactionGenerationId} sessionId=${sessionId} archiveSessionId=${archive.sessionId} version=${archive.version} frames=${archive.frames.length} mode=${mode} model=${model?.provider}/${model?.id} input=${(model as any)?.input}`);
      const decision = pickStrategy({
        model,
        mode,
        archive,
        archiveProducible: true,
        archiveMatchesSession: archive.sessionId === sessionId,
      });
      console.log(`[snapcompact] context decision: strategy=${decision.strategy} reason=${decision.reason} supportsImages=${modelSupportsImages(model as any)}`);
      if (decision.strategy !== "snapcompact") {
        if (fb) return { messages: [...before, { role: "user", content: [{ type: "text", text: fb }] }, ...after] };
        return undefined;
      }
      const profile = profileForModel(model);
      const { messages: projection } = buildProjectionMessages(archive, profile);
      return { messages: [...before, ...projection, ...after] };
    },
  ]);

  return ext;
}
