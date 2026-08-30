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
    const result = await ctxHandler({ messages: eventMessages }, { sessionManager: sm });
    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    // Original messages preserved in order
    expect(result.messages.length).toBeGreaterThan(eventMessages.length);
    for (let i = 0; i < eventMessages.length; i++) {
      expect(result.messages[i]).toEqual(eventMessages[i]);
    }
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
    expect(result.messages.length).toBeGreaterThan(ctx.messages.length);
    // Must NOT contain images
    const hasImage = result.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "image"));
    expect(hasImage).toBe(false);
    // Must contain the textual fallback with history
    const text = result.messages.map((m: any) => Array.isArray(m.content) ? m.content.map((b: any) => b.text ?? "").join("") : "").join("\n");
    expect(text).toContain("Snapcompact text fallback");
    expect(text.length).toBeGreaterThan(50);
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

  it("branch isolation: branch B without snapcompact does not leak branch A archive", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    // Build branch A with snapcompact
    const smA = makeSessionManager();
    const rootId = smA.appendMessage({ role: "user", content: "root" } as any);
    const cA = await beforeHandler({
      preparation: { firstKeptEntryId: "x", messagesToSummarize: [userMsg("branch A secret /repo/secret.ts")], turnPrefixMessages: [], tokensBefore: 10 },
    }, { sessionManager: smA });
    smA.appendCompaction(cA.compaction.summary, cA.compaction.firstKeptEntryId, cA.compaction.tokensBefore, cA.compaction.details as any, true);
    // Branch B diverges from root without any snapcompact compaction
    const smB = makeSessionManager();
    smB.appendMessage({ role: "user", content: "root" } as any);
    smB.appendMessage({ role: "user", content: "branch B ordinary message" } as any);
    const ctxB = smB.buildSessionContext();
    expect(ctxB.messages.some((m: any) => m.role === "compactionSummary")).toBe(false);
    const ctxHandler = ext.handlers.get("context")![0] as any;
    const resultB = await ctxHandler({ messages: ctxB.messages }, { sessionManager: smB });
    // Must NOT inject branch A's archive into branch B
    expect(resultB).toBeUndefined();
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
});
