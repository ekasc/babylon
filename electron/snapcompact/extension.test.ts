import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wireArr, wireNum, wireOf, wireStr } from "../../src/store";

/** Handler signature matching the SDK's HandlerFn (variadic unknown in). */
type HandlerFn = (...args: unknown[]) => Promise<unknown>;
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapcompactExtension } from "./extension";
import { ArchiveStore } from "./archive-store";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let stateDir = "";
let store: ArchiveStore;
let getMode: () => "automatic" | "summary" | "snapcompact";
let getModel: () => { provider?: string; id?: string; input?: string[] } | null | undefined;
let getSessionId: () => string;
let getSessionFile: () => string | null;
let sessionFile: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "pideck-snapcompact-ext-"));
  store = new ArchiveStore({ stateDir });
  getMode = () => "snapcompact";
  getModel = () => ({ provider: "openai", id: "gpt-4o", input: ["text", "image"] });
  getSessionId = () => "s1";
  sessionFile = "/sessions/s1.jsonl";
  getSessionFile = () => sessionFile;
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function buildExt() {
  return createSnapcompactExtension({
    archiveStore: store,
    getMode,
    getModel,
    getSessionId,
    getSessionFile,
  });
}

function userMsg(text: string, entryId = "u-" + Math.random().toString(36).slice(2, 6)): { role: string; content: string; entryId: string; timestamp: number } {
  return { role: "user", content: text, entryId, timestamp: 0 };
}

/** Compaction payload off a session_before_compact handler result. */
function compactionOf(result: unknown): Record<string, unknown> | undefined {
  return wireOf(wireOf(result)?.compaction);
}

/** Projected messages off a context handler result. */
function outMessages(result: unknown): unknown[] {
  return wireArr(wireOf(result), "messages") ?? [];
}

/** Plain text of projected messages (mirrors the serializer's text read). */
function outText(result: unknown): string {
  return outMessages(result).map((m) => {
    const content = wireOf(m)?.content;
    return Array.isArray(content) ? content.map((b) => wireStr(wireOf(b), "text") ?? "").join("") : "";
  }).join("\n");
}

function makeSessionManager(): SessionManager {
  // Use inMemory so no file I/O required; set cwd to tmpdir
  return SessionManager.inMemory(stateDir);
}

/** Fetch a registered handler by name; throws when the extension under test
 *  failed to register it (a loud failure beats an undefined call). */
function mustHandler(handlers: Map<string, HandlerFn[]>, name: string): HandlerFn {
  const fn = handlers.get(name)?.[0];
  if (!fn) throw new Error(`missing handler ${name}`);
  return fn;
}

describe("snapcompact Pi extension (session_before_compact + context)", () => {
  it("default summary mode does no snapcompact work (session_before_compact returns undefined, context is a no-op)", async () => {
    getMode = () => "summary";
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const result = await beforeHandler({ preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("a")], turnPrefixMessages: [], tokensBefore: 100 } }, {});
    expect(result).toBeUndefined();
  });

  it("session_before_compact builds an archive and returns a compaction with the marker", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const preparation = {
      firstKeptEntryId: "u1",
      messagesToSummarize: [userMsg("echo /repo/electron/snapshot-store.ts and commit 3335ebf", "u1")],
      turnPrefixMessages: [userMsg("previous turn", "u0")],
      tokensBefore: 500,
    };
    const result = await beforeHandler({ preparation }, { sessionManager: makeSessionManager() });
    expect(result).toBeDefined();
    expect(wireStr(compactionOf(result), "summary")).toMatch(/snapcompact/);
    expect(wireStr(compactionOf(result), "firstKeptEntryId")).toBeDefined();
    expect(compactionOf(result)?.tokensBefore).toBe(500);
    const details = wireOf(compactionOf(result)?.details);
    expect(typeof wireStr(details, "snapcompactGeneration")).toBe("string");
    expect(wireStr(details, "snapcompactProfile")).toBeDefined();
  });

  it("session_before_compact returns undefined when the model is visionless (snapcompact falls back)", async () => {
    getModel = () => ({ provider: "openai", id: "gpt-3.5", input: ["text"] });
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const result = await beforeHandler({
      preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("a")], turnPrefixMessages: [], tokensBefore: 0 },
    }, { sessionManager: makeSessionManager() });
    expect(result).toBeUndefined();
  });

  it("context event: model receives transient snapcompact context after real Pi compaction (via SessionManager)", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const preparation = {
      firstKeptEntryId: "u1",
      messagesToSummarize: [userMsg("discuss /repo/electron/snapshot-store.ts")],
      turnPrefixMessages: [userMsg("earlier", "u0")],
      tokensBefore: 200,
    };
    const sm = makeSessionManager();
    // Seed the session manager with some entries so the branch is valid
    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const compaction = await beforeHandler({ preparation }, { sessionManager: sm });
    expect(compaction).toBeDefined();
    const comp = compactionOf(compaction);
    // Simulate Pi persisting the compaction entry exactly as it would:
    // SessionManager.appendCompaction stores a CompactionEntry with
    // type:"compaction", fromHook:true, details.snapcompactGeneration.
    sm.appendCompaction(
      wireStr(comp, "summary") ?? "",
      wireStr(comp, "firstKeptEntryId") ?? "",
      wireNum(comp, "tokensBefore") ?? 0,
      comp?.details,
      true,
    );
    // Now simulate Pi's context rebuilding: buildSessionContext()
    // converts the CompactionEntry into a CompactionSummaryMessage
    // with role:"compactionSummary" (no details, no type:"compaction").
    const ctx = sm.buildSessionContext();
    // Verify the conversion happened — the messages the extension
    // receives contain role:"compactionSummary", not type:"compaction"
    expect(ctx.messages.some((m) => m.role === "compactionSummary")).toBe(true);
    expect(ctx.messages.some((m) => wireOf(m)?.type === "compaction")).toBe(false);

    // The extension's context handler must resolve the archive from
    // the session manager (which still has the CompactionEntry), not
    // from event.messages (which only has the summary).
    const ctxHandler = mustHandler(ext.handlers, "context");
    const eventMessages = ctx.messages;
    // Add a current user request after compaction so ordering matters
    sm.appendMessage({ role: "user", content: "CURRENT TASK", timestamp: Date.now() });
    const ctx2 = sm.buildSessionContext();
    const result = await ctxHandler({ messages: ctx2.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    const out = wireArr(wireOf(result), "messages") ?? [];
    expect(out).toBeDefined();
    // CompactionSummary marker is replaced, not appended — no "Recap: snapcompact" summary remains
    expect(out.some((m) => wireStr(wireOf(m), "role") === "compactionSummary")).toBe(false);
    // Projection appears before CURRENT TASK, and CURRENT TASK is last user request
    const toText = (m: unknown) => {
      const content = wireOf(m)?.content;
      if (Array.isArray(content)) {
        return content.map((b) => wireStr(wireOf(b), "text") ?? wireStr(wireOf(b), "content") ?? "").join("");
      }
      if (typeof content === "string") return content;
      return wireStr(wireOf(m), "summary") ?? "";
    };
    const flat = out.map(toText).join("\n");
    expect(flat).toContain("CURRENT TASK");
    const idxArchive = flat.indexOf("[Snapcompact archive]");
    const idxTask = flat.indexOf("CURRENT TASK");
    expect(idxArchive).toBeGreaterThan(-1);
    expect(idxArchive).toBeLessThan(idxTask);
    const lastUser = [...out].reverse().find((m) => wireStr(wireOf(m), "role") === "user");
    const lastText = toText(lastUser);
    expect(lastText).toContain("CURRENT TASK");
    // Images are real Pi ImageContent (base64 data, image/png mimeType).
    const imgMsg = out.find((m) => {
      const content = wireOf(m)?.content;
      return Array.isArray(content) && content.some((b) => wireOf(b)?.type === "image");
    });
    expect(imgMsg).toBeDefined();
    const imgContent = wireArr(wireOf(imgMsg), "content") ?? [];
    const imgBlock = wireOf(imgContent.find((b) => wireOf(b)?.type === "image"));
    expect(imgBlock?.type).toBe("image");
    expect(wireStr(imgBlock, "mimeType")).toBe("image/png");
    expect(typeof wireStr(imgBlock, "data")).toBe("string");
    expect(wireStr(imgBlock, "data")).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Header contains the exact-token dictionary (raw text).
    const headerMsg = out.find((m) => {
      const content = wireOf(m)?.content;
      return Array.isArray(content) && content.some((b) => {
        const w = wireOf(b);
        return w?.type === "text" && typeof w.text === "string" && w.text.includes("[Snapcompact archive]");
      });
    });
    expect(headerMsg).toBeDefined();
    const headerContent = wireArr(wireOf(headerMsg), "content") ?? [];
    const headerText = wireStr(wireOf(headerContent.find((b) => wireOf(b)?.type === "text")), "text");
    expect(headerText).toContain("[Snapcompact archive]");
    expect(headerText).toContain("E001=/repo/electron/snapshot-store.ts");
  });

  it("context event: text-only model after snapcompact compaction receives durable text fallback (no images)", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const compaction = await beforeHandler({
      preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("discuss /repo/electron/snapshot-store.ts with secret")], turnPrefixMessages: [], tokensBefore: 100 },
    }, { sessionManager: sm });
    const comp = compactionOf(compaction);
    sm.appendCompaction(
      wireStr(comp, "summary") ?? "",
      wireStr(comp, "firstKeptEntryId") ?? "",
      wireNum(comp, "tokensBefore") ?? 0,
      comp?.details,
      true,
    );
    const ctx = sm.buildSessionContext();
    // Switch to text-only model — must still get history via textFallback, not empty
    getModel = () => ({ provider: "openai", id: "gpt-3.5", input: ["text"] });
    getMode = () => "snapcompact";
    const visionlessExt = createSnapcompactExtension({ archiveStore: store, getMode, getModel, getSessionId, getSessionFile });
    const ctxHandler2 = mustHandler(visionlessExt.handlers, "context");
    const result = await ctxHandler2({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    const out = wireArr(wireOf(result), "messages") ?? [];
    // Replacement: compactionSummary (-1) + fallback (+1) => same length
    expect(out.length).toBe(ctx.messages.length);
    expect(out.some((m) => wireStr(wireOf(m), "role") === "compactionSummary")).toBe(false);
    const hasImage = out.some((m) => {
      const content = wireOf(m)?.content;
      return Array.isArray(content) && content.some((b) => wireOf(b)?.type === "image");
    });
    expect(hasImage).toBe(false);
    const toText2 = (m: unknown) => {
      const w = wireOf(m);
      const content = w?.content;
      if (Array.isArray(content)) {
        return content.map((b) => wireStr(wireOf(b), "text") ?? "").join("");
      }
      if (typeof content === "string") return content;
      return wireStr(w, "summary") ?? "";
    };
    const text = out.map(toText2).join("\n");
    expect(text).toContain("Snapcompact text fallback");
  });

  it("context event: the archive remains present across multiple LLM calls (multi-step tool turn)", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const compaction = await beforeHandler({
      preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("/repo/electron/snapshot-store.ts")], turnPrefixMessages: [], tokensBefore: 100 },
    }, { sessionManager: sm });
    const comp = compactionOf(compaction);
    sm.appendCompaction(
      wireStr(comp, "summary") ?? "",
      wireStr(comp, "firstKeptEntryId") ?? "",
      wireNum(comp, "tokensBefore") ?? 0,
      comp?.details,
      true,
    );
    const ctx = sm.buildSessionContext();
    const ctxHandler = mustHandler(ext.handlers, "context");
    for (let i = 0; i < 3; i++) {
      const result = await ctxHandler({ messages: ctx.messages }, { sessionManager: sm });
      expect((wireArr(wireOf(result), "messages") ?? []).length).toBeGreaterThan(ctx.messages.length);
    }
  });

  it("context event: when there is no snapcompact marker, the messages pass through unchanged", async () => {
    const ext = buildExt();
    const ctxHandler = mustHandler(ext.handlers, "context");
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const ctx = sm.buildSessionContext();
    const result = await ctxHandler({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeUndefined();
  });

  it("branch addressability: navigating back to older branch still loads its generation", async () => {
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "branch A start", timestamp: Date.now() });
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const c1 = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("branch A content /repo/a.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    {
      const comp = compactionOf(c1);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    const gen1 = String(wireStr(wireOf(compactionOf(c1)?.details), "snapcompactGeneration"));
    sm.appendMessage({ role: "user", content: "branch B continuation", timestamp: Date.now() });
    const c2 = await beforeHandler({
      preparation: { firstKeptEntryId: "y", messagesToSummarize: [userMsg("branch B content /repo/b.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    {
      const comp = compactionOf(c2);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    const gen2 = String(wireStr(wireOf(compactionOf(c2)?.details), "snapcompactGeneration"));
    const a1 = await store.loadGeneration(sessionFile, gen1);
    expect(a1).not.toBeNull();
    expect(a1!.compactionGenerationId).toBe(gen1);
    const a2 = await store.loadGeneration(sessionFile, gen2);
    expect(a2).not.toBeNull();
    expect(a2!.compactionGenerationId).toBe(gen2);
    const active = await store.load(sessionFile);
    expect(active!.compactionGenerationId).toBe(gen2);
    const ctxHandler = mustHandler(ext.handlers, "context");
    const smA = makeSessionManager();
    smA.appendMessage({ role: "user", content: "branch A start", timestamp: Date.now() });
    {
      const comp = compactionOf(c1);
      smA.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    const ctxA = smA.buildSessionContext();
    const resultA = await ctxHandler({ messages: ctxA.messages }, { sessionManager: smA });
    expect(resultA).toBeDefined();
    expect((wireArr(wireOf(resultA), "messages") ?? []).length).toBeGreaterThan(ctxA.messages.length);
  });

  it("branch isolation: branch B without snapcompact does not leak branch A archive (separate managers)", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const smA = makeSessionManager();
    smA.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    const cA = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("branch A secret /repo/secret.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: smA });
    {
      const comp = compactionOf(cA);
      smA.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    const smB = makeSessionManager();
    smB.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    smB.appendMessage({ role: "user", content: "branch B ordinary message", timestamp: Date.now() });
    const ctxB = smB.buildSessionContext();
    expect(ctxB.messages.some((m) => m.role === "compactionSummary")).toBe(false);
    const ctxHandler = mustHandler(ext.handlers, "context");
    const resultB = await ctxHandler({ messages: ctxB.messages }, { sessionManager: smB });
    expect(resultB).toBeUndefined();
  });

  it("branch isolation: real divergent branch via SessionManager.branch() does not leak", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    const rootId = sm.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    // Branch A: snapcompact compaction
    const cA = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("branch A secret /repo/a.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    {
      const comp = compactionOf(cA);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    // Diverge: go back to root and create branch B without snapcompact
    sm.branch(rootId);
    sm.appendMessage({ role: "user", content: "branch B ordinary", timestamp: Date.now() });
    const ctxB = sm.buildSessionContext();
    // Active branch B has no snapcompact compaction
    expect(ctxB.messages.some((m) => m.role === "compactionSummary" && String(wireOf(m)?.summary ?? "").includes("snapcompact"))).toBe(false);
    const ctxHandler = mustHandler(ext.handlers, "context");
    const resultB = await ctxHandler({ messages: ctxB.messages }, { sessionManager: sm });
    expect(resultB).toBeUndefined();
  });

  it("textFallback survives ArchiveStore restart and works for text-only model via fresh store", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const c = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("restart test /repo/restart.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    const gen = String(wireStr(wireOf(compactionOf(c)?.details), "snapcompactGeneration"));
    {
      const comp = compactionOf(c);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    // Simulate Babylon restart: new ArchiveStore instance
    const freshStore = new ArchiveStore({ stateDir });
    const loaded = await freshStore.loadGeneration(sessionFile, gen);
    expect(loaded).not.toBeNull();
    expect(loaded!.textFallback).toBeDefined();
    expect(loaded!.textFallback!.length).toBeGreaterThan(0);
    expect(loaded!.textFallback).toContain("restart");
    // Now use fresh store in a new extension with text-only model
    getModel = () => ({ provider: "openai", id: "gpt-3.5", input: ["text"] });
    getMode = () => "snapcompact";
    const freshExt = createSnapcompactExtension({ archiveStore: freshStore, getMode, getModel, getSessionId, getSessionFile });
    const ctx = sm.buildSessionContext();
    const ctxHandler = mustHandler(freshExt.handlers, "context");
    const result = await ctxHandler({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    const text = outText(result);
    expect(text).toContain("Snapcompact text fallback");
  });

  it("chronology: textFallback replaces marker before CURRENT TASK and last user is CURRENT TASK", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const c = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("fallback chronology /repo/f.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    {
      const comp = compactionOf(c);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    sm.appendMessage({ role: "user", content: "CURRENT TASK FALLBACK", timestamp: Date.now() });
    const ctx = sm.buildSessionContext();
    getModel = () => ({ provider: "openai", id: "gpt-3.5", input: ["text"] });
    getMode = () => "snapcompact";
    const freshExt = createSnapcompactExtension({ archiveStore: store, getMode, getModel, getSessionId, getSessionFile });
    const chronoHandler = mustHandler(freshExt.handlers, "context");
    const result = await chronoHandler({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    const out = wireArr(wireOf(result), "messages") ?? [];
    expect(out.some((m) => wireStr(wireOf(m), "role") === "compactionSummary")).toBe(false);
    const toText = (m: unknown) => {
      const w = wireOf(m);
      const content = w?.content;
      if (Array.isArray(content)) return content.map((b) => wireStr(wireOf(b), "text") ?? "").join("");
      if (typeof content === "string") return content;
      return wireStr(w, "summary") ?? "";
    };
    const flat = out.map(toText).join("\n");
    expect(flat.indexOf("Snapcompact text fallback")).toBeLessThan(flat.indexOf("CURRENT TASK FALLBACK"));
    const lastUser = [...out].reverse().find((m) => wireStr(wireOf(m), "role") === "user");
    expect(toText(lastUser)).toContain("CURRENT TASK FALLBACK");
    // Canonical not mutated
    expect(sm.getEntries().some((e) => e.type === "compaction" && wireStr(wireOf(e.details), "snapcompactGeneration"))).toBe(true);
    expect(ctx.messages.some((m) => m.role === "compactionSummary")).toBe(true);
  });

  it("mode switched to summary after snapcompact compaction still injects textFallback", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const c = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("summary mode fallback /repo/summary.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    {
      const comp = compactionOf(c);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    const ctx = sm.buildSessionContext();
    // User changes setting Snapcompact -> Summary
    getMode = () => "summary";
    const summaryExt = createSnapcompactExtension({ archiveStore: store, getMode, getModel, getSessionId, getSessionFile });
    const ctxHandler = mustHandler(summaryExt.handlers, "context");
    const result = await ctxHandler({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    const text = outText(result);
    expect(text).toContain("Snapcompact text fallback");
    expect(text).not.toContain("[Snapcompact archive] generation=");
  });

  it("snapcompact -> snapcompact rollover is cumulative (G2 retains OLD_FACT)", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    const c1 = await beforeHandler({ preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("OLD_FACT_123", "u-old")], turnPrefixMessages: [], tokensBefore: 10 } }, { sessionManager: sm });
    expect(c1).toBeDefined();
    {
      const comp = compactionOf(c1);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    expect(wireStr(compactionOf(c1), "summary")).toContain("Snapcompact text fallback");
    expect(wireStr(compactionOf(c1), "summary")).toContain("OLD_FACT_123");
    // New conversation after G1
    const c2 = await beforeHandler({ preparation: { firstKeptEntryId: "y", messagesToSummarize: [userMsg("NEW_FACT_456", "u-new")], turnPrefixMessages: [], tokensBefore: 10 } }, { sessionManager: sm });
    expect(c2).toBeDefined();
    {
      const comp = compactionOf(c2);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    const g2 = await store.load(sessionFile);
    expect(g2).not.toBeNull();
    expect(g2!.sourceText).toContain("OLD_FACT_123");
    expect(g2!.sourceText).toContain("NEW_FACT_456");
    // Context projects G2 only, which is already cumulative
    const ctx = sm.buildSessionContext();
    const result = await (mustHandler(ext.handlers, "context"))({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    expect(outMessages(result).some((m) => wireStr(wireOf(m), "role") === "compactionSummary")).toBe(false);
  });

  it("persisted snapcompact summary carries bounded textFallback for future Pi textual compaction", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    const c = await beforeHandler({ preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("fallback in summary /repo/f.ts", "u1")], turnPrefixMessages: [], tokensBefore: 10 } }, { sessionManager: sm });
    const summary = wireStr(compactionOf(c), "summary") ?? "";
    expect(summary).toContain("[Snapcompact generation=");
    expect(summary).toContain("Snapcompact text fallback");
    expect(summary.length).toBeLessThanOrEqual(5000);
  });

  it("split-turn ordering: archive built from messagesToSummarize before turnPrefixMessages", async () => {
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = makeSessionManager();
    const prep = {
      firstKeptEntryId: "u1",
      messagesToSummarize: [userMsg("older history", "u-old")],
      turnPrefixMessages: [userMsg("split turn prefix", "u-split")],
      tokensBefore: 100,
    };
    const result = await beforeHandler({ preparation: prep }, { sessionManager: sm });
    // Load the archive and verify ordering: older history appears before split prefix
    const archive = await store.load(sessionFile);
    expect(archive).not.toBeNull();
    const idxOlder = archive!.sourceText.indexOf("older history");
    const idxSplit = archive!.sourceText.indexOf("split turn prefix");
    expect(idxOlder).toBeGreaterThanOrEqual(0);
    expect(idxSplit).toBeGreaterThanOrEqual(0);
    expect(idxOlder).toBeLessThan(idxSplit);
  });

  it("branch contamination: first Snapcompact on active branch B does not archive inactive branch A", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pideck-snapcompact-branch-"));
    const realSessionFile = join(dir, "s.jsonl");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(realSessionFile, "");
    const branchFile = realSessionFile;
    getSessionFile = () => branchFile;
    const ext = buildExt();
    const beforeHandler = mustHandler(ext.handlers, "session_before_compact");
    const sm = SessionManager.open(realSessionFile, undefined, dir);
    const rootMsgId = sm.appendMessage({ role: "user", content: "ROOT", timestamp: Date.now() });
    // Branch A
    sm.appendMessage({ role: "user", content: "BRANCH_A_SENTINEL", timestamp: Date.now() });
    const aLeaf = sm.getLeafId();
    sm.branch(rootMsgId);
    // Branch B active with >10 entries
    const bIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = sm.appendMessage({ role: "user", content: `B-msg-${i} /repo/b${i}.ts`, timestamp: Date.now() });
      bIds.push(id);
    }
    const bLeaf = sm.getLeafId();
    const activeBefore = sm.getBranch().map((e) => e.id);
    expect(activeBefore).toContain(bLeaf);
    expect(activeBefore).not.toContain(aLeaf);
    const compacted = await beforeHandler(
      { preparation: { firstKeptEntryId: bLeaf, messagesToSummarize: [userMsg("b-snap")], turnPrefixMessages: [], tokensBefore: 5000 } },
      { sessionManager: sm }
    );
    expect(compacted).toBeDefined();
    {
      const comp = compactionOf(compacted);
      sm.appendCompaction(wireStr(comp, "summary") ?? "", wireStr(comp, "firstKeptEntryId") ?? "", wireNum(comp, "tokensBefore") ?? 0, comp?.details, true);
    }
    const archive = await store.load(branchFile);
    expect(archive).not.toBeNull();
    expect(archive!.sourceText).toContain("B-msg-0");
    expect(archive!.sourceText).not.toContain("BRANCH_A_SENTINEL");
    const firstKept = wireStr(compactionOf(compacted), "firstKeptEntryId");
    const activeAfter = sm.getBranch().map((e) => e.id);
    expect(activeAfter).toContain(firstKept);
    expect(activeAfter).toContain(sm.getLeafId());
    // Persist and restart
    const sm2 = SessionManager.open(realSessionFile, undefined, dir);
    const activeAfterRestart = sm2.getBranch().map((e) => e.id);
    expect(activeAfterRestart).toContain(firstKept);
    const archive2 = await store.load(branchFile);
    expect(archive2!.sourceText).not.toContain("BRANCH_A_SENTINEL");
    rmSync(dir, { recursive: true, force: true });
  });
});
