import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapcompactExtension } from "./extension";
import { ArchiveStore } from "./archive-store";
import { profileForModel } from "./model-profiles";

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

function pngStub(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 13, 10, 26, 10]);
}

function userMsg(text: string, entryId = "u-" + Math.random().toString(36).slice(2, 6)): any {
  return { role: "user", content: text, entryId, timestamp: 0 };
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
    const result = await beforeHandler({ preparation }, {});
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
    }, {});
    expect(result).toBeUndefined();
  });

  it("context event: model receives transient snapcompact context + the original user message; canonical user message is unchanged", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const preparation = {
      firstKeptEntryId: "u1",
      messagesToSummarize: [userMsg("discuss /repo/electron/snapshot-store.ts")],
      turnPrefixMessages: [userMsg("earlier", "u0")],
      tokensBefore: 200,
    };
    const compaction = await beforeHandler({ preparation }, {});
    expect(compaction).toBeDefined();
    // Pi would store the compaction result and on the next LLM call
    // would rebuild messages, including the marker, and emit the
    // `context` event. We simulate that by adding the marker to a
    // rebuilt messages array alongside the canonical user message
    // "hello". The canonical user message is passed through verbatim;
    // the projection is appended transiently.
    const marker = {
      type: "compaction",
      summary: compaction.compaction.summary,
      firstKeptEntryId: compaction.compaction.firstKeptEntryId,
      tokensBefore: compaction.compaction.tokensBefore,
      fromHook: true,
      details: compaction.compaction.details,
    };
    // Pi's own context rebuild puts the compaction entry and the
    // canonical user message "hello" into the rebuilt messages.
    const rebuilt = [userMsg("hello", "u-real"), marker];
    // Pi's own context event signature: { messages }.
    const ctxHandler = ext.handlers.get("context")![0] as any;
    const result = await ctxHandler({ messages: rebuilt }, {});
    expect(result).toBeDefined();
    expect(result.messages).toBeDefined();
    // The canonical user message must be the first element and unchanged.
    expect(result.messages[0]).toEqual(rebuilt[0]);
    expect(result.messages[0].content).toBe("hello");
    // The projection is appended (header user-message + images user-message).
    expect(result.messages.length).toBeGreaterThan(1);
    // Images are real Pi ImageContent (base64 data, image/png mimeType).
    const imgMsg = result.messages.find((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "image"));
    expect(imgMsg).toBeDefined();
    const imgBlock = imgMsg.content.find((b: any) => b?.type === "image");
    expect(imgBlock.type).toBe("image");
    expect(imgBlock.mimeType).toBe("image/png");
    expect(typeof imgBlock.data).toBe("string");
    expect(imgBlock.data).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
    // The header contains the exact-token dictionary (raw text).
    const headerMsg = result.messages.find((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b?.type === "text"));
    expect(headerMsg).toBeDefined();
    const headerText = headerMsg.content.find((b: any) => b?.type === "text").text;
    expect(headerText).toContain("[Snapcompact archive]");
    expect(headerText).toContain("E001=/repo/electron/snapshot-store.ts");
    expect(headerText).toContain("--- exact-token dictionary ---");
  });

  it("context event: the archive remains present across multiple LLM calls (multi-step tool turn)", async () => {
    const ext = buildExt();
    const beforeHandler = ext.handlers.get("session_before_compact")![0] as any;
    const compaction = await beforeHandler({
      preparation: { firstKeptEntryId: "u1", messagesToSummarize: [userMsg("/repo/electron/snapshot-store.ts")], turnPrefixMessages: [], tokensBefore: 100 },
    }, {});
    const marker = {
      type: "compaction",
      summary: compaction.compaction.summary,
      firstKeptEntryId: compaction.compaction.firstKeptEntryId,
      tokensBefore: compaction.compaction.tokensBefore,
      fromHook: true,
      details: compaction.compaction.details,
    };
    const rebuilt = [userMsg("step 1", "u-step1"), marker, userMsg("step 2", "u-step2"), userMsg("step 3", "u-step3")];
    const ctxHandler = ext.handlers.get("context")![0] as any;
    // Simulate three consecutive LLM calls in one turn.
    for (let i = 0; i < 3; i++) {
      const result = await ctxHandler({ messages: rebuilt }, {});
      // Every call must surface the projection (because the marker is
      // still present), and the canonical messages remain unchanged.
      expect(result.messages.length).toBeGreaterThan(rebuilt.length);
      for (const canonical of rebuilt) {
        expect(result.messages).toContainEqual(canonical);
      }
    }
  });

  it("context event: when there is no snapcompact marker, the messages pass through unchanged", async () => {
    const ext = buildExt();
    const ctxHandler = ext.handlers.get("context")![0] as any;
    const rebuilt = [userMsg("hello", "u-1"), { role: "assistant", content: "hi" }];
    const result = await ctxHandler({ messages: rebuilt }, {});
    expect(result).toBeUndefined();
  });
});
