import { describe, expect, it } from "vitest";
import { serializeTranscript, MARKER, PER_TOOL_RESULT_BUDGET } from "./serializer";
import { extractHighValueTokens, assignIds } from "./symbol-dictionary";

function user(text: string, entryId = `u-${Math.random()}`) {
  return { role: "user", content: text, entryId, timestamp: 0 };
}
function assistant(text: string, opts: { toolCalls?: any[]; model?: string; entryId?: string; thinking?: string } = {}) {
  const content: any[] = [];
  if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
  if (text) content.push({ type: "text", text });
  return { role: "assistant", content, toolCalls: opts.toolCalls, model: opts.model, entryId: opts.entryId ?? `a-${Math.random()}` };
}
function toolResult(toolCallId: string, text: string, isError = false, truncated = false) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text }], isError, truncated, entryId: `tr-${Math.random()}` };
}

describe("snapcompact serializer", () => {
  it("emits a deterministic, role-tagged transcript", () => {
    const messages = [
      user("ship it", "u1"),
      assistant("ack.", { toolCalls: [{ id: "tc1", name: "bash", arguments: '{"command":"ls"}' }], model: "claude-x", entryId: "a1" }),
      toolResult("tc1", "src\nREADME.md\n"),
      user("thanks", "u2"),
    ];
    const a = serializeTranscript({ messages });
    const b = serializeTranscript({ messages });
    expect(a.sourceText).toBe(b.sourceText);
    expect(a.sourceText).toContain(MARKER.user);
    expect(a.sourceText).toContain(MARKER.assistant);
    expect(a.sourceText).toContain(MARKER.tool);
    expect(a.sourceText).toContain(MARKER.result);
    expect(a.sourceText).toMatch(/model=claude-x/);
  });

  it("pairs tool calls with their results by toolCallId and names the tool", () => {
    const messages = [
      assistant("", { toolCalls: [{ id: "tc1", name: "read", arguments: '{"path":"x.ts"}' }] }),
      toolResult("tc1", "file contents"),
      assistant("", { toolCalls: [{ id: "tc2", name: "bash", arguments: '{"command":"pwd"}' }] }),
      toolResult("tc2", "/tmp"),
    ];
    const out = serializeTranscript({ messages });
    expect(out.sourceText).toMatch(/¶tool read\n\{"path":"x\.ts"\}/);
    expect(out.sourceText).toMatch(/¶tool bash\n\{"command":"pwd"\}/);
    expect(out.sourceText.indexOf("read")).toBeLessThan(out.sourceText.indexOf("file contents"));
    expect(out.sourceText.indexOf("bash")).toBeLessThan(out.sourceText.indexOf("/tmp"));
  });

  it("preserves errors with the error marker", () => {
    const messages = [
      assistant("", { toolCalls: [{ id: "tc1", name: "bash", arguments: "{}" }] }),
      toolResult("tc1", "command not found", true),
    ];
    const out = serializeTranscript({ messages });
    expect(out.sourceText).toContain(`${MARKER.result} error`);
    expect(out.sourceText).toContain("command not found");
  });

  it("strips image-only messages and image blocks from text", () => {
    const messages = [
      { role: "user", content: [{ type: "image", data: "BASE64DATA", mimeType: "image/png" }], entryId: "u-img", timestamp: 0 },
      user("describe the screenshot", "u1"),
      assistant("the screenshot shows a login form"),
    ];
    const out = serializeTranscript({ messages });
    expect(out.skipped).toBe(1);
    expect(out.sourceText).not.toContain("BASE64DATA");
    expect(out.sourceText).toContain("describe the screenshot");
  });

  it("truncates pathological tool results deterministically with a marker", () => {
    const huge = "x".repeat(PER_TOOL_RESULT_BUDGET * 4);
    const messages = [
      assistant("", { toolCalls: [{ id: "tc1", name: "bash", arguments: "{}" }] }),
      toolResult("tc1", huge),
    ];
    const out = serializeTranscript({ messages });
    expect(out.sourceText).toMatch(/\[truncated/);
    expect(out.sourceText.length).toBeLessThan(huge.length);
  });

  it("truncates by dropping whole messages from the end and reports truthful coverage", () => {
    const many = Array.from({ length: 200 }, (_, i) => user(`message ${i} ${"y".repeat(500)}`, `u${i}`));
    const out = serializeTranscript({ messages: many, totalBudget: 2000 });
    expect(out.truncated).toBe(true);
    // Coverage: kept range is the head, omitted trailing names the rest.
    expect(out.firstKeptEntryId).toBe("u0");
    expect(out.lastKeptEntryId).not.toBe("u199");
    expect(out.omittedTrailing.length).toBeGreaterThan(0);
    // Every omitted trailing entry is one of the dropped ones.
    for (const o of out.omittedTrailing) {
      const n = Number(o.entryId.replace("u", ""));
      expect(n).toBeGreaterThanOrEqual(out.keptCount);
    }
    // Source text length respects the budget plus a small seam.
    expect(out.sourceText.length).toBeLessThanOrEqual(2000);
    // The kept block contains early messages and ends with the omission
    // marker for the truncated archive.
    expect(out.sourceText).toMatch(/message 0/);
  });

  it("preserves first/last kept entry IDs from the input array (not the last input)", () => {
    const msgs = [user("a", "u0"), user("b", "u1"), user("c", "u2"), user("d", "u3")];
    const out = serializeTranscript({ messages: msgs, totalBudget: 50 });
    expect(out.firstKeptEntryId).toBe("u0");
    if (out.keptCount < 4) {
      expect(out.lastKeptEntryId).not.toBe("u3");
      expect(out.omittedTrailing.some((o) => o.entryId === "u3")).toBe(true);
    }
  });

  it("records image-only tool results as omitted entries (skipped, not in the total-budget tail)", () => {
    const messages = [
      { role: "user", content: "hi", entryId: "u0", timestamp: 0 },
      { role: "toolResult", toolCallId: "tc1", content: [{ type: "image", data: "B64", mimeType: "image/png" }], entryId: "tr-img", timestamp: 0 },
    ];
    const out = serializeTranscript({ messages });
    expect(out.sourceText).toContain("hi");
    expect(out.sourceText).not.toContain("B64");
    expect(out.omittedTrailing.some((o) => o.entryId === "tr-img" && o.reason === "tool-result-image-only")).toBe(true);
  });

  it("serializes thinking blocks under the ¶thinking marker", () => {
    const messages = [
      assistant("done.", { thinking: "I should refactor this", entryId: "a1" }),
    ];
    const out = serializeTranscript({ messages });
    expect(out.sourceText).toContain(`${MARKER.thinking}\nI should refactor this`);
    expect(out.sourceText).toContain("done.");
  });

  it("serializes custom messages with their customType", () => {
    const messages = [
      { role: "custom", customType: "babylon_recap", content: "Recap: did the thing", display: true, timestamp: 1, entryId: "r1" },
    ];
    const out = serializeTranscript({ messages });
    expect(out.sourceText).toContain(`${MARKER.custom} babylon_recap`);
    expect(out.sourceText).toContain("Recap: did the thing");
  });
});

describe("snapcompact symbol dictionary", () => {
  it("extracts paths, shas, urls, versions, branches, env, ports, commands, identifiers", () => {
    const text = [
      "ran git checkout main and pulled commit a1b2c3d4e5f6",
      "see https://example.com/foo",
      "package @scope/bar@1.2.3 depends on lib@2.0.0",
      "open http://localhost:3000/api or 127.0.0.1:8080",
      "PATH=/usr/local/bin NODE_ENV=production",
      "ran `pnpm install` and `node ./scripts/x.js`",
      "function captureTurnStart and class SnapshotStore",
    ].join("\n");
    const symbols = extractHighValueTokens(text);
    const kinds = new Map(symbols.map((s) => [s.value, s.kind]));
    expect(kinds.get("main")).toBe("branch");
    expect(kinds.get("a1b2c3d4e5f6")).toBe("sha");
    expect(kinds.get("https://example.com/foo")).toBe("url");
    expect(kinds.get("1.2.3")).toBe("version");
    expect(kinds.get("3000")).toBe("port");
    expect(kinds.get("8080")).toBe("port");
    expect(kinds.get("PATH")).toBe("env");
    expect(kinds.get("NODE_ENV")).toBe("env");
    expect(kinds.get("pnpm install")).toBe("command");
    expect(kinds.get("captureTurnStart")).toBe("identifier");
    expect(kinds.get("SnapshotStore")).toBe("identifier");
  });

  it("assigns deterministic sequential IDs in the order symbols first appear", () => {
    const a = assignIds(extractHighValueTokens("see a1b2c3d4 and then a1b2c3d4 again"));
    const b = assignIds(extractHighValueTokens("see a1b2c3d4 and then a1b2c3d4 again"));
    expect(a).toEqual(b);
    expect(a[0].id).toBe("E001");
    expect(a[0].value).toBe("a1b2c3d4");
  });

  it("replaces repeated references with the same anchor", () => {
    const text = "see /repo/electron/snapshot-store.ts and /repo/electron/snapshot-store.ts again";
    const symbols = extractHighValueTokens(text);
    const ids = assignIds(symbols);
    const value = "/repo/electron/snapshot-store.ts";
    expect(ids.filter((s) => s.value === value)).toHaveLength(1);
  });
});
