import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDesignModeExtension } from "./extension";
import { createDesignState, loadDesignState, saveDesignState } from "./store";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const SESSION_ID = "test-session-01";

function mockCtx() {
  return {
    hasUI: true,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionCommandContext;
}

async function makeProject(tag: string) {
  const root = await mkdtemp(join(tmpdir(), `pideck-design-${tag}-`));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  return { root, cwd };
}

async function seedDesign(cwd: string, subject = "Redesign settings") {
  const state = createDesignState(subject, "redesign-settings");
  await saveDesignState(cwd, SESSION_ID, state);
  return state;
}

describe("design approvals continue the workflow", () => {
  it("approve-brief flips the flag and starts the brand stage", async () => {
    const { cwd } = await makeProject("approve-brief");
    const state = await seedDesign(cwd);
    await mkdir(join(cwd, "design"), { recursive: true });
    await writeFile(join(cwd, state.briefPath), "# Brief\n");
    const followUps: string[] = [];
    const ext = createDesignModeExtension({
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      sendFollowUp: (text: string) => void followUps.push(text),
    });
    const handler = ext.commands?.get("design")?.handler;
    expect(handler).toBeDefined();
    await handler!("approve-brief", mockCtx());
    expect((await loadDesignState(cwd, SESSION_ID))?.briefApproved).toBe(true);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatch(/brand stage/i);
  });

  it("approve-brand flips the flag and starts the build stage", async () => {
    const { cwd } = await makeProject("approve-brand");
    const state = await seedDesign(cwd);
    await mkdir(join(cwd, "design"), { recursive: true });
    await writeFile(join(cwd, state.briefPath), "# Brief\n");
    await saveDesignState(cwd, SESSION_ID, { ...state, briefApproved: true });
    await writeFile(join(cwd, state.brandPath), "# Brand\n");
    const followUps: string[] = [];
    const ext = createDesignModeExtension({
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      sendFollowUp: (text: string) => void followUps.push(text),
    });
    const handler = ext.commands?.get("design")?.handler;
    await handler!("approve-brand", mockCtx());
    expect((await loadDesignState(cwd, SESSION_ID))?.brandApproved).toBe(true);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatch(/build stage/i);
  });

  it("approve-brief without a brief artifact warns and sends nothing", async () => {
    const { cwd } = await makeProject("approve-empty");
    await seedDesign(cwd);
    const followUps: string[] = [];
    const ext = createDesignModeExtension({
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      sendFollowUp: (text: string) => void followUps.push(text),
    });
    const ctx = mockCtx();
    const handler = ext.commands?.get("design")?.handler;
    await handler!("approve-brief", ctx);
    expect(followUps).toHaveLength(0);
    expect((await loadDesignState(cwd, SESSION_ID))?.briefApproved).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/interview/i), "warning");
  });
});

describe("design_set_target tool", () => {
  it("records web, mobile-web, and native", async () => {
    const { cwd } = await makeProject("target");
    await seedDesign(cwd);
    const ext = createDesignModeExtension({
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      sendFollowUp: () => undefined,
    });
    const tool = ext.tools?.get("design_set_target");
    expect(tool).toBeDefined();
    const execute = tool!.definition.execute;
    for (const target of ["mobile-web", "native", "web"] as const) {
      const result = await execute("call-1", { target }, undefined, undefined, {} as unknown as ExtensionContext);
      expect((await loadDesignState(cwd, SESSION_ID))?.target).toBe(target);
      expect(JSON.stringify(result)).toMatch(new RegExp(target));
    }
  });

  it("rejects unknown targets and missing sessions", async () => {
    const { cwd } = await makeProject("target-bad");
    await seedDesign(cwd);
    const ext = createDesignModeExtension({
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      sendFollowUp: () => undefined,
    });
    const execute = ext.tools?.get("design_set_target")?.definition.execute;
    expect(execute).toBeDefined();
    await expect(execute!("call-1", { target: "desktop" }, undefined, undefined, {} as unknown as ExtensionContext)).rejects.toThrow(/web, mobile-web, or native/);
    await expect(execute!("call-1", {}, undefined, undefined, {} as unknown as ExtensionContext)).rejects.toThrow();
    expect((await loadDesignState(cwd, SESSION_ID))?.target).toBe("web");
  });
});
