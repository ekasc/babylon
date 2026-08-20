import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiHost } from "./pi-host";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("PiHost open new session while already in project", () => {
  it("creates a distinct new session file each time open({ path: undefined }) is called", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-newses-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const otherCwd = join(root, "other-project");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(otherCwd, { recursive: true })]);

    const host = new PiHost({ cwd, agentDir, onEvent: () => undefined, onStatus: () => undefined });
    await host.start();

    // Real flow: host starts in `cwd`, the user then asks for a new session in a
    // different project, so runtime.cwd !== opts.cwd and host.open takes the
    // SessionManager.create + switchSession branch.
    const first = await host.open({ path: undefined, cwd: otherCwd });
    expect(first?.sessionFile).toBeTruthy();

    // A second "new session" while already in the project must NOT reuse the
    // first session file — otherwise the old conversation is silently lost and
    // the action appears to do nothing.
    const second = await host.open({ path: undefined, cwd: otherCwd });
    expect(second?.sessionFile).toBeTruthy();
    expect(second?.sessionFile).not.toBe(first?.sessionFile);

    await host.dispose();
  }, 30_000);
});
