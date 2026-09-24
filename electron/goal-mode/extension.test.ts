import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { GOAL_INLINE_PATH, createGoalModeExtension, isExternalGoalModeExtension } from "./extension";
import { loadDesignState, saveDesignState, createDesignState } from "../design-mode/store";
import { loadSessionGoal, saveSessionGoal } from "./store";
import { createDurableGoalState, defaultDurableGoalModeConfig } from "../../src/lib/durable-goal";

describe("isExternalGoalModeExtension", () => {
  it("keeps the hardbaked inline copy", () => {
    expect(
      isExternalGoalModeExtension({ path: GOAL_INLINE_PATH, resolvedPath: GOAL_INLINE_PATH, commands: new Map([["goal", {}]]) })
    ).toBe(false);
  });

  it("drops extensions registering the goal command", () => {
    expect(
      isExternalGoalModeExtension({ path: "/users/x/.pi/extensions/other", commands: new Map([["goal", {}]]) })
    ).toBe(true);
  });

  it("drops goal-mode directories by path as a fallback", () => {
    expect(isExternalGoalModeExtension({ path: "/users/x/.pi/extensions/goal-mode" })).toBe(true);
    expect(isExternalGoalModeExtension({ resolvedPath: "/repo/.pi/extensions/goal-mode/index.ts" })).toBe(true);
  });

  it("keeps unrelated extensions", () => {
    expect(isExternalGoalModeExtension({ path: "/x/snapcompact", commands: new Map() })).toBe(false);
    expect(isExternalGoalModeExtension({})).toBe(false);
  });
});

describe("goal/design mutual exclusion", () => {
  const SESSION_ID = "test-session-01";

  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function makeProject(tag: string) {
    const root = await mkdtemp(join(tmpdir(), `pideck-goal-excl-${tag}-`));
    roots.push(root);
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    return { cwd };
  }

  function mockCtx() {
    return {
      hasUI: true,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    } as unknown as ExtensionCommandContext;
  }

  function mockDeps(cwd: string, followUps: string[]) {
    return {
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      isProjectTrusted: () => true,
      sendFollowUp: (text: string) => void followUps.push(text),
    };
  }

  it("bare /goal objective is refused while a design is active", async () => {
    const { cwd } = await makeProject("blocked");
    await saveDesignState(cwd, SESSION_ID, createDesignState("Redesign", "redesign"));
    const followUps: string[] = [];
    const ext = createGoalModeExtension(mockDeps(cwd, followUps));
    const ctx = mockCtx();
    await ext.commands?.get("goal")?.handler("Fix the race", ctx);
    expect(await loadSessionGoal(cwd, SESSION_ID)).toBeNull();
    expect(followUps).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/design.*active/i), "warning");
    // The design itself is untouched.
    expect((await loadDesignState(cwd, SESSION_ID))?.subject).toBe("Redesign");
  });

  it("goal pause/done/clear still work under an active design", async () => {
    const { cwd } = await makeProject("escape");
    await saveDesignState(cwd, SESSION_ID, createDesignState("Redesign", "redesign"));
    await saveSessionGoal(cwd, SESSION_ID, { ...createDurableGoalState("Fix it", defaultDurableGoalModeConfig()), paused: true, status: "paused" });
    const ext = createGoalModeExtension(mockDeps(cwd, []));
    const ctx = mockCtx();
    // Pause lands (reduces pursuit); done clears the way out entirely.
    await ext.commands?.get("goal")?.handler("pause", ctx);
    expect((await loadSessionGoal(cwd, SESSION_ID))?.paused).toBe(true);
    await ext.commands?.get("goal")?.handler("done", ctx);
    expect((await loadSessionGoal(cwd, SESSION_ID))?.active).toBe(false);
  });

  it("goal resume is refused while a design is active", async () => {
    const { cwd } = await makeProject("resume-blocked");
    await saveDesignState(cwd, SESSION_ID, createDesignState("Redesign", "redesign"));
    await saveSessionGoal(cwd, SESSION_ID, { ...createDurableGoalState("Fix it", defaultDurableGoalModeConfig()), paused: true, status: "paused" });
    const ext = createGoalModeExtension(mockDeps(cwd, []));
    const ctx = mockCtx();
    await ext.commands?.get("goal")?.handler("resume", ctx);
    expect((await loadSessionGoal(cwd, SESSION_ID))?.paused).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/design.*active/i), "warning");
  });
});
