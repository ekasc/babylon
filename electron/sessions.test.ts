import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex, readSessionInfo } from "./sessions";

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
