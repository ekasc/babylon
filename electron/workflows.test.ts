import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowsBridge } from "./workflows";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function projectKey(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = (basename(projectPath) || "project")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
  return `${slug}-${createHash("sha256").update(projectPath).digest("hex").slice(0, 12)}`;
}

function run(runId: string) {
  return {
    runId,
    workflowName: "count_to_15_x100",
    description: "Runs 100 agents",
    script: "",
    sessionId: "session-1",
    status: "completed",
    phases: [],
    agents: [],
    logs: [],
    startedAt: "2026-08-13T10:46:31.647Z",
    updatedAt: "2026-08-13T10:46:45.435Z",
    completedAt: "2026-08-13T10:46:45.435Z",
  };
}

describe("WorkflowsBridge", () => {
  it("finds runs written under the canonical cwd namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "babylon-workflows-"));
    roots.push(root);
    const canonical = join(root, "canonical-project");
    const lexical = join(root, "project-link");
    const workflowHome = join(root, "workflow-home");
    await mkdir(canonical);
    await symlink(canonical, lexical, "dir");

    const runId = "count-to-15-x100-test";
    const runsDir = join(workflowHome, "projects", projectKey(await realpath(lexical)), "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, `${runId}.json`), `${JSON.stringify(run(runId))}\n`);

    const bridge = new WorkflowsBridge({
      cwd: lexical,
      workflowHomeDir: workflowHome,
      runCommand: async () => undefined,
      getSessionId: async () => "session-1",
      onUpdate: () => undefined,
    });
    expect(await bridge.list()).toEqual([
      expect.objectContaining({ runId, workflowName: "count_to_15_x100", status: "completed" }),
    ]);
    expect(await bridge.get(runId)).toEqual(expect.objectContaining({ runId }));
    bridge.dispose();
  });

  it("shows only runs owned by the active conversation session", async () => {
    const root = await mkdtemp(join(tmpdir(), "babylon-workflow-owner-"));
    roots.push(root);
    const workflowHome = join(root, "workflow-home");
    const runsDir = join(workflowHome, "projects", projectKey(await realpath(root)), "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "ours.json"), `${JSON.stringify(run("ours"))}\n`);
    await writeFile(join(runsDir, "theirs.json"), `${JSON.stringify({ ...run("theirs"), sessionId: "session-2" })}\n`);

    const bridge = new WorkflowsBridge({
      cwd: root,
      workflowHomeDir: workflowHome,
      runCommand: async () => undefined,
      getSessionId: async () => "session-1",
      onUpdate: () => undefined,
    });
    expect((await bridge.list()).map((item) => item.runId)).toEqual(["ours"]);
    expect(await bridge.get("ours")).toEqual(expect.objectContaining({ runId: "ours" }));
    expect(await bridge.get("theirs")).toBeNull();
    bridge.dispose();
  });

  it("does not publish an in-flight refresh after disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "babylon-workflows-race-"));
    roots.push(root);
    const workflowHome = join(root, "workflow-home");
    const runsDir = join(workflowHome, "projects", projectKey(await realpath(root)), "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, "stale-run.json"), `${JSON.stringify(run("stale-run"))}\n`);

    let release!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const updates: string[][] = [];
    const bridge = new WorkflowsBridge({
      cwd: root,
      workflowHomeDir: workflowHome,
      runCommand: async () => undefined,
      getSessionId: async () => "session-1",
      onUpdate: (runs) => updates.push(runs.map((item) => item.runId)),
    });
    const originalRealpath = (bridge as any).runsDirs.bind(bridge);
    (bridge as any).runsDirs = async () => {
      await blocked;
      return originalRealpath();
    };

    bridge.start();
    bridge.dispose();
    release();
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(updates).toEqual([]);
  });
});
