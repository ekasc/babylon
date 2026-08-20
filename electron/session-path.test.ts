import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateSessionPath } from "./session-path";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("session path validation", () => {
  it("accepts a real transcript below the canonical root", async () => {
    const root = await mkdtemp(join(tmpdir(), "babylon-session-root-"));
    roots.push(root);
    const project = join(root, "project");
    const file = join(project, "session.jsonl");
    await mkdir(project);
    await writeFile(file, "{}\n");
    await expect(validateSessionPath(root, file)).resolves.toBe(await realpath(file));
  });

  it("rejects a transcript symlink escaping the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "babylon-session-root-"));
    const outside = await mkdtemp(join(tmpdir(), "babylon-session-outside-"));
    roots.push(root, outside);
    const target = join(outside, "secret.jsonl");
    const link = join(root, "secret.jsonl");
    await writeFile(target, "secret\n");
    await symlink(target, link);
    await expect(validateSessionPath(root, link)).rejects.toThrow("outside");
  });
});
