import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapcompactExtension } from "./extension";
import { ArchiveStore } from "./archive-store";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let stateDir = "";
let store: ArchiveStore;
let getMode: () => "automatic" | "summary" | "snapcompact";
let getModel: () => any;
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

function userMsg(text: string, entryId = "u-" + Math.random().toString(36).slice(2, 6)): any {
  return { role: "user", content: text, entryId, timestamp: 0 };
}

function makeSessionManager(): SessionManager {
  // Use inMemory so no file I/O required; set cwd to tmpdir
  return SessionManager.inMemory(stateDir);
}

describe("snapcompact Pi extension (session_before_compact + context)", () => {
  it("default summary mode does no snapcompact work (session_before_compact returns undefined, context is a no-op)", async () => {
    getMode = () => "summary";
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const result = await beforeHandler({ preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("a")], turnPrefixMessages: [], tokensBefore: 100 } }, {});
    expect(result).toBeUndefined();
  });

  it("session_before_compact builds an archive and returns a compaction with the marker", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const preparation = {
      firstKeptEntryId: "u1",
      messagesToSummarize: [userMsg("echo /repo/electron/snapshot-store.ts and commit 3335ebf", "u1")],
      turnPrefixMessages: [userMsg("previous turn", "u0")],
      tokensBefore: 500,
    };
    const result = await beforeHandler({ preparation }, { sessionManager: makeSessionManager() });
    expect(result).toBeDefined();
    expect(result.compaction.summary).toMatch(/snapcompact/);
    expect(result.compaction.firstKeptEntryId).toBeDefined();
    expect(result.compaction.tokensBefore).toBe(500);
    const details = result.compaction.details as any;
    expect(typeof details.snapcompactGeneration).toBe("string");
    expect(details.snapcompactProfile).toBeDefined();
  });

  it("session_before_compact returns undefined when the model is visionless (snapcompact falls back)", async () => {
    getModel = () => ({ provider: "openai", id: "gpt-3.5", input: ["text"] });
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const result = await beforeHandler({
      preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("a")], turnPrefixMessages: [], tokensBefore: 0 },
    }, { sessionManager: makeSessionManager() });
    expect(result).toBeUndefined();
  });

  it("context event: model receives transient snapcompact context after real Pi compaction (via SessionManager)", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const preparation = {
      firstKeptEntryId: "u1",
      messagesToSummarize: [userMsg("discuss /repo/electron/snapshot-store.ts")],
      turnPrefixMessages: [userMsg("earlier", "u0")],
      tokensBefore: 200,
    };
    const sm = makeSessionManager();
    // Seed the session manager with some entries so the branch is valid
    sm.appendMessage({ role: "user", content: "hello" } as any);
    const compaction = await beforeHandler({ preparation }, { sessionManager: sm });
    expect(compaction).toBeDefined();
    // Simulate Pi persisting the compaction entry exactly as it would:
    // SessionManager.appendCompaction stores a CompactionEntry with
    // type:"compaction", fromHook:true, details.snapcompactGeneration.
    sm.appendCompaction(
      compaction.compaction.summary,
      compaction.compaction.firstKeptEntryId,
      compaction.compaction.tokensBefore,
      compaction.compaction.details as any,
      true,
    );
    // Now simulate Pi's context rebuilding: buildSessionContext()
    // converts the CompactionEntry into a CompactionSummaryMessage
    // with role:"compactionSummary" (no details, no type:"compaction").
    const ctx = sm.buildSessionContext();
    // Verify the conversion happened — the messages the extension
    // receives contain role:"compactionSummary", not type:"compaction"
    expect(ctx.messages.some((m: any) => m.role === "compactionSummary")).toBe(true);
    expect(ctx.messages.some((m: any) => m.type === "compaction")).toBe(false);

    // The extension's context handler must resolve the archive from
    // the session manager (which still has the CompactionEntry), not
    // from event.messages (which only has the summary).
    const ctxHandler = ext.handlers.get("context")![0] as any;
    const eventMessages = ctx.messages;
    // Add a current user request after compaction so ordering matters
    sm.appendMessage({ role: "user", content: "CURRENT TASK" } as any);
    const ctx2 = sm.buildSessionContext();
    const result = await ctxHandler({ messages: ctx2.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    // CompactionSummary marker is replaced, not appended — no "Recap: snapcompact" summary remains
    expect(result.messages.some((m: any) => m.role === "compactionSummary")).toBe(false);
    // Projection appears before CURRENT TASK, and CURRENT TASK is last user request
    const toText = (m: any) => {
      if (Array.isArray(m.content)) return m.content.map((b: any) => b.text ?? b.content ?? "").join("");
      if (typeof m.content === "string") return m.content;
      return m.summary ?? "";
    };
    const flat = result.messages.map(toText).join("\n");
    expect(flat).toContain("CURRENT TASK");
    const idxArchive = flat.indexOf("[Snapcompact archive]");
    const idxTask = flat.indexOf("CURRENT TASK");
    expect(idxArchive).toBeGreaterThan(-1);
    expect(idxArchive).toBeLessThan(idxTask);
    const lastUser = [...result.messages].reverse().find((m: any) => m.role === "user");
    const lastText = toText(lastUser);
    expect(lastText).toContain("CURRENT TASK");
    // Images are real Pi ImageContent (base64 data, image/png mimeType).
    const imgMsg = result.messages.find((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "image"));
    expect(imgMsg).toBeDefined();
    const imgBlock = imgMsg.content.find((b: any) => b?.type === "image");
    expect(imgBlock.type).toBe("image");
    expect(imgBlock.mimeType).toBe("image/png");
    expect(typeof imgBlock.data).toBe("string");
    expect(imgBlock.data).toMatch(/^[A-Za-z0-9+/=]+$/);
    // Header contains the exact-token dictionary (raw text).
    const headerMsg = result.messages.find((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.includes("[Snapcompact archive]")));
    expect(headerMsg).toBeDefined();
    const headerText = headerMsg.content.find((b: any) => b?.type === "text").text;
    expect(headerText).toContain("[Snapcompact archive]");
    expect(headerText).toContain("E001=/repo/electron/snapshot-store.ts");
  });

  it("context event: text-only model after snapcompact compaction receives durable text fallback (no images)", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello" } as any);
    const compaction = await beforeHandler({
      preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("discuss /repo/electron/snapshot-store.ts with secret")], turnPrefixMessages: [], tokensBefore: 100 },
    }, { sessionManager: sm });
    sm.appendCompaction(compaction.compaction.summary, compaction.compaction.firstKeptEntryId, compaction.compaction.tokensBefore, compaction.compaction.details as any, true);
    const ctx = sm.buildSessionContext();
    // Switch to text-only model — must still get history via textFallback, not empty
    getModel = () => ({ provider: "openai", id: "gpt-3.5", input: ["text"] });
    getMode = () => "snapcompact";
    const visionlessExt = createSnapcompactExtension({ archiveStore: store, getMode, getModel, getSessionId, getSessionFile });
    const ctxHandler2 = visionlessExt.handlers.get("context")![0] as any;
    const result = await ctxHandler2({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    // Replacement: compactionSummary (-1) + fallback (+1) => same length
    expect(result.messages.length).toBe(ctx.messages.length);
    expect(result.messages.some((m: any) => m.role === "compactionSummary")).toBe(false);
    const hasImage = result.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "image"));
    expect(hasImage).toBe(false);
    const toText2 = (m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.text ?? "").join("") : typeof m.content === "string" ? m.content : m.summary ?? "";
    const text = result.messages.map(toText2).join("\n");
    expect(text).toContain("Snapcompact text fallback");
  });

  it("context event: the archive remains present across multiple LLM calls (multi-step tool turn)", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello" } as any);
    const compaction = await beforeHandler({
      preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("/repo/electron/snapshot-store.ts")], turnPrefixMessages: [], tokensBefore: 100 },
    }, { sessionManager: sm });
    sm.appendCompaction(compaction.compaction.summary, compaction.compaction.firstKeptEntryId, compaction.compaction.tokensBefore, compaction.compaction.details as any, true);
    const ctx = sm.buildSessionContext();
    const ctxHandler = ext.handlers.get("context")![0] as any;
    for (let i = 0; i < 3; i++) {
      const result = await ctxHandler({ messages: ctx.messages }, { sessionManager: sm });
      expect(result.messages.length).toBeGreaterThan(ctx.messages.length);
    }
  });

  it("context event: when there is no snapcompact marker, the messages pass through unchanged", async () => {
    const ext = buildExt();
    const ctxHandler = ext.handlers.get("context")![0] as any;
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello" } as any);
    const ctx = sm.buildSessionContext();
    const result = await ctxHandler({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeUndefined();
  });

  it("branch addressability: navigating back to older branch still loads its generation", async () => {
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "branch A start" } as any);
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const c1 = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("branch A content /repo/a.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    sm.appendCompaction(c1.compaction.summary, c1.compaction.firstKeptEntryId, c1.compaction.tokensBefore, c1.compaction.details as any, true);
    const gen1 = String(c1.compaction.details.snapcompactGeneration);
    sm.appendMessage({ role: "user", content: "branch B continuation" } as any);
    const c2 = await beforeHandler({
      preparation: { firstKeptEntryId: "y", messagesToSummarize: [userMsg("branch B content /repo/b.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    sm.appendCompaction(c2.compaction.summary, c2.compaction.firstKeptEntryId, c2.compaction.tokensBefore, c2.compaction.details as any, true);
    const gen2 = String(c2.compaction.details.snapcompactGeneration);
    const a1 = await store.loadGeneration(sessionFile, gen1);
    expect(a1).not.toBeNull();
    expect(a1!.compactionGenerationId).toBe(gen1);
    const a2 = await store.loadGeneration(sessionFile, gen2);
    expect(a2).not.toBeNull();
    expect(a2!.compactionGenerationId).toBe(gen2);
    const active = await store.load(sessionFile);
    expect(active!.compactionGenerationId).toBe(gen2);
    const ctxHandler = ext.handlers.get("context")![0] as any;
    const smA = makeSessionManager();
    smA.appendMessage({ role: "user", content: "branch A start" } as any);
    smA.appendCompaction(c1.compaction.summary, c1.compaction.firstKeptEntryId, c1.compaction.tokensBefore, c1.compaction.details as any, true);
    const ctxA = smA.buildSessionContext();
    const resultA = await ctxHandler({ messages: ctxA.messages }, { sessionManager: smA });
    expect(resultA).toBeDefined();
    expect(resultA.messages.length).toBeGreaterThan(ctxA.messages.length);
  });

  it("branch isolation: branch B without snapcompact does not leak branch A archive (separate managers)", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const smA = makeSessionManager();
    smA.appendMessage({ role: "user", content: "root" } as any);
    const cA = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("branch A secret /repo/secret.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: smA });
    smA.appendCompaction(cA.compaction.summary, cA.compaction.firstKeptEntryId, cA.compaction.tokensBefore, cA.compaction.details as any, true);
    const smB = makeSessionManager();
    smB.appendMessage({ role: "user", content: "root" } as any);
    smB.appendMessage({ role: "user", content: "branch B ordinary message" } as any);
    const ctxB = smB.buildSessionContext();
    expect(ctxB.messages.some((m: any) => m.role === "compactionSummary")).toBe(false);
    const ctxHandler = ext.handlers.get("context")![0] as any;
    const resultB = await ctxHandler({ messages: ctxB.messages }, { sessionManager: smB });
    expect(resultB).toBeUndefined();
  });

  it("branch isolation: real divergent branch via SessionManager.branch() does not leak", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = makeSessionManager();
    const rootId = sm.appendMessage({ role: "user", content: "root" } as any);
    // Branch A: snapcompact compaction
    const cA = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("branch A secret /repo/a.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    sm.appendCompaction(cA.compaction.summary, cA.compaction.firstKeptEntryId, cA.compaction.tokensBefore, cA.compaction.details as any, true);
    // Diverge: go back to root and create branch B without snapcompact
    sm.branch(rootId);
    sm.appendMessage({ role: "user", content: "branch B ordinary" } as any);
    const ctxB = sm.buildSessionContext();
    // Active branch B has no snapcompact compaction
    expect(ctxB.messages.some((m: any) => m.role === "compactionSummary" && String(m.summary ?? "").includes("snapcompact"))).toBe(false);
    const ctxHandler = ext.handlers.get("context")![0] as any;
    const resultB = await ctxHandler({ messages: ctxB.messages }, { sessionManager: sm });
    expect(resultB).toBeUndefined();
  });

  it("textFallback survives ArchiveStore restart and works for text-only model via fresh store", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello" } as any);
    const c = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("restart test /repo/restart.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    const gen = String(c.compaction.details.snapcompactGeneration);
    sm.appendCompaction(c.compaction.summary, c.compaction.firstKeptEntryId, c.compaction.tokensBefore, c.compaction.details as any, true);
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
    const ctxHandler = freshExt.handlers.get("context")![0] as any;
    const result = await ctxHandler({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    const text = result.messages.map((m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.text ?? "").join("") : "").join("\n");
    expect(text).toContain("Snapcompact text fallback");
  });

  it("chronology: textFallback replaces marker before CURRENT TASK and last user is CURRENT TASK", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello" } as any);
    const c = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("fallback chronology /repo/f.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    sm.appendCompaction(c.compaction.summary, c.compaction.firstKeptEntryId, c.compaction.tokensBefore, c.compaction.details as any, true);
    sm.appendMessage({ role: "user", content: "CURRENT TASK FALLBACK" } as any);
    const ctx = sm.buildSessionContext();
    getModel = () => ({ provider: "openai", id: "gpt-3.5", input: ["text"] });
    getMode = () => "snapcompact";
    const freshExt = createSnapcompactExtension({ archiveStore: store, getMode, getModel, getSessionId, getSessionFile });
    const result = await (freshExt.handlers.get("context")![0] as any)({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    expect((result as any).messages.some((m: any) => m.role === "compactionSummary")).toBe(false);
    const toText = (m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.text ?? "").join("") : typeof m.content === "string" ? m.content : m.summary ?? "";
    const flat = (result as any).messages.map(toText).join("\n");
    expect(flat.indexOf("Snapcompact text fallback")).toBeLessThan(flat.indexOf("CURRENT TASK FALLBACK"));
    const lastUser = [...(result as any).messages].reverse().find((m: any) => m.role === "user");
    expect(toText(lastUser)).toContain("CURRENT TASK FALLBACK");
    // Canonical not mutated
    expect(sm.getEntries().some((e: any) => e.type === "compaction" && e.details?.snapcompactGeneration)).toBe(true);
    expect(ctx.messages.some((m: any) => m.role === "compactionSummary")).toBe(true);
  });

  it("mode switched to summary after snapcompact compaction still injects textFallback", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello" } as any);
    const c = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("summary mode fallback /repo/summary.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: sm });
    sm.appendCompaction(c.compaction.summary, c.compaction.firstKeptEntryId, c.compaction.tokensBefore, c.compaction.details as any, true);
    const ctx = sm.buildSessionContext();
    // User changes setting Snapcompact -> Summary
    getMode = () => "summary";
    const summaryExt = createSnapcompactExtension({ archiveStore: store, getMode, getModel, getSessionId, getSessionFile });
    const ctxHandler = summaryExt.handlers.get("context")![0] as any;
    const result = await ctxHandler({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    const text = result.messages.map((m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.text ?? "").join("") : "").join("\n");
    expect(text).toContain("Snapcompact text fallback");
    expect(text).not.toContain("[Snapcompact archive] generation=");
  });

  it("snapcompact -> snapcompact rollover is cumulative (G2 retains OLD_FACT)", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = makeSessionManager();
    sm.appendMessage({ role: "user", content: "hello" } as any);
    const c1 = await beforeHandler({ preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("OLD_FACT_123", "u-old")], turnPrefixMessages: [], tokensBefore: 10 } }, { sessionManager: sm });
    expect(c1).toBeDefined();
    sm.appendCompaction(c1.compaction.summary, c1.compaction.firstKeptEntryId, c1.compaction.tokensBefore, c1.compaction.details as any, true);
    expect(c1.compaction.summary).toContain("Snapcompact text fallback");
    expect(c1.compaction.summary).toContain("OLD_FACT_123");
    // New conversation after G1
    const c2 = await beforeHandler({ preparation: { firstKeptEntryId: "y", messagesToSummarize: [userMsg("NEW_FACT_456", "u-new")], turnPrefixMessages: [], tokensBefore: 10 } }, { sessionManager: sm });
    expect(c2).toBeDefined();
    sm.appendCompaction(c2.compaction.summary, c2.compaction.firstKeptEntryId, c2.compaction.tokensBefore, c2.compaction.details as any, true);
    const g2 = await store.load(sessionFile);
    expect(g2).not.toBeNull();
    expect(g2!.sourceText).toContain("OLD_FACT_123");
    expect(g2!.sourceText).toContain("NEW_FACT_456");
    // Context projects G2 only, which is already cumulative
    const ctx = sm.buildSessionContext();
    const result = await (ext.handlers.get("context")![0] as any)({ messages: ctx.messages }, { sessionManager: sm });
    expect(result).toBeDefined();
    expect(result.messages.some((m: any) => m.role === "compactionSummary")).toBe(false);
  });

  it("persisted snapcompact summary carries bounded textFallback for future Pi textual compaction", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = makeSessionManager();
    const c = await beforeHandler({ preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("fallback in summary /repo/f.ts", "u1")], turnPrefixMessages: [], tokensBefore: 10 } }, { sessionManager: sm });
    expect(c.compaction.summary).toContain("[Snapcompact generation=");
    expect(c.compaction.summary).toContain("Snapcompact text fallback");
    expect(c.compaction.summary.length).toBeLessThanOrEqual(5000);
  });

  it("split-turn ordering: archive built from messagesToSummarize before turnPrefixMessages", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
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
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const sm = SessionManager.open(realSessionFile, undefined, dir);
    const rootMsgId = sm.appendMessage({ role: "user", content: "ROOT" } as any);
    // Branch A
    sm.appendMessage({ role: "user", content: "BRANCH_A_SENTINEL" } as any);
    const aLeaf = sm.getLeafId();
    sm.branch(rootMsgId);
    // Branch B active with >10 entries
    const bIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = sm.appendMessage({ role: "user", content: `B-msg-${i} /repo/b${i}.ts` } as any);
      bIds.push(id);
    }
    const bLeaf = sm.getLeafId();
    const activeBefore = sm.getBranch().map((e: any) => e.id);
    expect(activeBefore).toContain(bLeaf);
    expect(activeBefore).not.toContain(aLeaf);
    const compacted = await beforeHandler(
      { preparation: { firstKeptEntryId: bLeaf, messagesToSummarize: [userMsg("b-snap")], turnPrefixMessages: [], tokensBefore: 5000 } },
      { sessionManager: sm }
    );
    expect(compacted).toBeDefined();
    sm.appendCompaction(compacted.compaction.summary, compacted.compaction.firstKeptEntryId, compacted.compaction.tokensBefore, compacted.compaction.details as any, true);
    const archive = await store.load(branchFile);
    expect(archive).not.toBeNull();
    expect(archive!.sourceText).toContain("B-msg-0");
    expect(archive!.sourceText).not.toContain("BRANCH_A_SENTINEL");
    const firstKept = compacted.compaction.firstKeptEntryId;
    const activeAfter = sm.getBranch().map((e: any) => e.id);
    expect(activeAfter).toContain(firstKept);
    expect(activeAfter).toContain(sm.getLeafId());
    // Persist and restart
    const sm2 = SessionManager.open(realSessionFile, undefined, dir);
    const activeAfterRestart = sm2.getBranch().map((e: any) => e.id);
    expect(activeAfterRestart).toContain(firstKept);
    const archive2 = await store.load(branchFile);
    expect(archive2!.sourceText).not.toContain("BRANCH_A_SENTINEL");
    rmSync(dir, { recursive: true, force: true });
  });
});
