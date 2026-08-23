import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex, clampToolOutput, readSessionInfo, readSessionRange, readSessionTail, readToolOutput } from "./sessions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(lines: unknown[]): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "pideck-sessions-"));
  roots.push(root);
  const projectDir = join(root, "--project--");
  await mkdir(projectDir);
  const file = join(projectDir, "session.jsonl");
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { root, file };
}

describe("session metadata", () => {
  it("uses the latest tail session name without reading the large middle", async () => {
    const header = { type: "session", id: "s1", cwd: "/project", timestamp: "2026-01-01T00:00:00Z" };
    const user = { type: "message", message: { role: "user", content: "Initial task" } };
    const { file } = await fixture([header, user]);
    await appendFile(file, `${" ".repeat(220_000)}\n`);
    await appendFile(file, JSON.stringify({ type: "session_info", name: "Current name" }) + "\n");

    const info = await readSessionInfo(file);
    expect(info).toMatchObject({ id: "s1", cwd: "/project", name: "Current name", firstUserText: "Initial task" });
  });

  it("indexes and groups sessions while retaining worktree metadata", async () => {
    const { root } = await fixture([
      { type: "session", id: "s2", cwd: "/repo", parentSession: "/old.jsonl" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Try it" }] } },
    ]);
    const index = new SessionIndex(root);
    const groups = await index.list();
    index.dispose();
    expect(groups[0]?.sessions[0]).toMatchObject({ id: "s2", name: "Try it", isWorktree: true, parentPath: "/old.jsonl" });
  });
});

describe("tool output clamping", () => {
  it("clamps toolResult text blocks and flags truncation", () => {
    const big = "x".repeat(100_000);
    const message = clampToolOutput({
      role: "toolResult",
      toolCallId: "t1",
      content: [{ type: "text", text: big }, { type: "text", text: "tail" }],
    });
    const text = message.content.map((b: any) => b.text).join("");
    expect(text.length).toBeLessThanOrEqual(16 * 1024);
    expect(message.truncated).toBe(true);
    expect(text).not.toContain("tail"); // blocks after the cap are dropped
  });

  it("keeps small outputs and diffs untouched", () => {
    const small = clampToolOutput({ role: "toolResult", toolCallId: "t2", content: [{ type: "text", text: "ok" }] });
    expect(small.truncated).toBeUndefined();
    const diff = "x".repeat(50_000);
    const withPatch = clampToolOutput({ role: "toolResult", content: [{ type: "text", text: "ok" }], details: { patch: diff } });
    expect(withPatch.details.patch).toBe(diff); // diffs ship in full
  });
});

describe("tail-first session reads", () => {
  it("reads only the tail window of a large file", async () => {
    const header = { type: "session", id: "s1", cwd: "/project", timestamp: "2026-01-01T00:00:00Z" };
    const oldMessage = { type: "message", id: "m1", message: { role: "user", content: "old" } };
    const newMessage = { type: "message", id: "m2", message: { role: "assistant", content: "new" } };
    const { file } = await fixture([header, oldMessage]);
    await appendFile(file, `${" ".repeat(1_000_000)}\n`);
    await appendFile(file, JSON.stringify(newMessage) + "\n");

    const tail = await readSessionTail(file, 4 * 1024);
    expect(tail.messages.map((m: any) => m.content)).toEqual(["new"]);
    expect(tail.startOffset).toBeGreaterThan(0);
  });

  it("carries the entry timestamp into projected messages so recaps interleave", async () => {
    // Regression: projection used to drop the entry-level timestamp, so every
    // message sorted as t=0 and recap annotations piled up after the last
    // message instead of interleaving by time.
    const msg = { type: "message", id: "m1", timestamp: "2026-01-01T10:00:00Z", message: { role: "user", content: "hi" } };
    const { file } = await fixture([
      { type: "session", id: "s1", cwd: "/project", timestamp: "2026-01-01T00:00:00Z" },
      msg,
    ]);
    const tail = await readSessionTail(file, 4096);
    expect(typeof tail.messages[0].timestamp).toBe("number");
    expect(tail.messages[0].timestamp).toBe(Date.parse("2026-01-01T10:00:00Z"));
  });

  it("loads older windows ending at a given offset", async () => {
    const header = { type: "session", id: "s1", cwd: "/project", timestamp: "2026-01-01T00:00:00Z" };
    const oldMessage = { type: "message", id: "m1", message: { role: "user", content: "old" } };
    const pad = { type: "pad", blob: "x".repeat(1_000_000) };
    const newMessage = { type: "message", id: "m2", message: { role: "assistant", content: "new" } };
    const { file } = await fixture([header, oldMessage, pad]);
    await appendFile(file, JSON.stringify(newMessage) + "\n");

    const tail = await readSessionTail(file, 1024);
    expect(tail.messages.map((m: any) => m.content)).toEqual(["new"]);
    // The older window ends where the tail began; it must extend backward past
    // the 1MB pad line to reach the complete "old" message.
    const older = await readSessionRange(file, tail.startOffset, 1024);
    expect(older.messages.map((m: any) => m.content)).toContain("old");
    expect(older.startOffset).toBeGreaterThan(0);
  });

  it("clamps an oversized end offset to the file size", async () => {
    const message = { type: "message", id: "m1", message: { role: "user", content: "safe" } };
    const { file } = await fixture([{ type: "session", id: "s1", cwd: "/project" }, message]);
    const result = await readSessionRange(file, Number.MAX_SAFE_INTEGER, 1024);
    expect(result.messages.map((m: any) => m.content)).toEqual(["safe"]);
  });

  it("fetches a full tool output on demand", async () => {
    const big = "y".repeat(50_000);
    const tool = { type: "message", id: "m1", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: big }] } };
    const { file } = await fixture([{ type: "session", id: "s1", cwd: "/project", timestamp: "2026-01-01T00:00:00Z" }, tool]);
    const result = await readToolOutput(file, "t1");
    expect(result.content).toBe(big);
    expect(result.truncated).toBe(false);
  });
});
