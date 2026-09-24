import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesignModeExtension, type DesignModeExtensionDeps } from "./extension";
import type { RegisteredTool } from "@earendil-works/pi-coding-agent";
import { createDesignState, loadDesignState, saveDesignState, JUDGE_MAX_ROUNDS } from "./store";
import { nextReviewRound, reviewRoundDir } from "./review";
import type { ReviewBundle } from "../sim-controller";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))));

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-reviewtool-${tag}-`));
  roots.push(cwd);
  return cwd;
}

const bundle = (): ReviewBundle => ({
  url: "http://localhost:5173",
  screenshots: [{ viewport: "Chrome", preset: "chrome-laptop", png: Buffer.from("png-desktop"), width: 1280, height: 800 }],
  consoleErrors: [],
  pageErrors: [],
  textSnapshot: "t",
  axSnapshot: "a",
});

/** Invoke a registered tool the way the runtime does. */
async function runTool(
  tool: RegisteredTool | undefined,
  params: Record<string, unknown>
): Promise<{ details: unknown; content: Array<{ type: string }> }> {
  if (!tool) throw new Error("tool missing");
  type Args = Parameters<typeof tool.definition.execute>;
  const args = [
    "call-x",
    params,
    undefined,
    undefined,
    {},
  ] as unknown as Args;
  const result = (await tool.definition.execute(...args)) as {
    details: unknown;
    content: Array<{ type: string }>;
  };
  return result;
}

const SESSION_ID = "019ff998-0000-4000-8000-000000000001";

function harness(cwd: string, state: { target: "web" | "mobile-web" | "native" }, capture?: ReviewBundle) {
  const calls: Array<{ url: string; viewports: unknown }> = [];
  const deps: DesignModeExtensionDeps = {
    getCwd: () => cwd,
    getSessionId: () => SESSION_ID,
    sendFollowUp: () => undefined,
    captureReview: async (opts) => {
      calls.push({ url: opts.url, viewports: opts.viewports });
      return capture ?? bundle();
    },
  };
  const extension = createDesignModeExtension(deps);
  const tool = extension.tools?.get("design_review");
  if (!tool) throw new Error("design_review tool is not registered");
  // The real signature carries a signal, an update callback and a context;
  // the tool only ever uses the first two.
  const execute = (id: string, params: Record<string, unknown>) => runTool(tool, params);
  return { calls, execute };
}

/** A state with both approvals in place: review is only legal after both. */
async function approvedState(cwd: string, target: "web" | "mobile-web" | "native" = "web") {
  const state = createDesignState("Sessions UI", "sessions-ui");
  state.target = target;
  state.briefApproved = true;
  state.brandApproved = true;
  await saveDesignState(cwd, SESSION_ID, state);
  // Artifacts must exist for the approvals to survive sanitization.
  await writeFile(join(cwd, state.briefPath), "# brief", "utf-8");
  await writeFile(join(cwd, state.brandPath), "# direction", "utf-8");
  return state;
}

describe("design_set_phase tool", () => {
  it("stores only the reported phase, and rejects an unknown one", async () => {
    const cwd = await makeProject("setphase");
    const state = await approvedState(cwd);
    const { execute } = harness(cwd, state);
    const extension = createDesignModeExtension({
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      sendFollowUp: () => undefined,
    });
    const tool = extension.tools?.get("design_set_phase");

    await runTool(tool, { phase: "implementing" });
    expect((await loadDesignState(cwd, SESSION_ID))?.phase).toBe("implementing");
    await runTool(tool, { phase: "needs-user" });
    expect((await loadDesignState(cwd, SESSION_ID))?.phase).toBe("needs-user");
    // "reviewing" is deliberately not a phase: an in-flight review is visible
    // as a running tool call, and persisting it would survive a crash.
    await expect(runTool(tool, { phase: "reviewing" })).rejects.toThrow(/Unknown phase/);
    void execute;
  });
});

describe("design_review tool", () => {
  it("captures, persists, and records one round as a single call", async () => {
    const cwd = await makeProject("round");
    const state = await approvedState(cwd);
    const { calls, execute } = harness(cwd, state);

    const result = await execute("call-1", {
      verdict: "fail",
      punchlist: ["Header spacing is too tight"],
      note: "Hierarchy improved.",
      url: "http://localhost:5173",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:5173");
    // Defaults to mobile + desktop, so the round is comparable across runs.
    expect((calls[0]?.viewports as Array<{ preset: string }>).map((v) => v.preset)).toEqual([
      "iphone",
      "chrome-laptop",
    ]);

    const details = result.details as { round: number; verdict: string; punchlist: string[]; shots: unknown[] };
    expect(details.round).toBe(1);
    expect(details.verdict).toBe("fail");
    expect(details.punchlist).toEqual(["Header spacing is too tight"]);
    expect(details.shots).toHaveLength(1);
    // The screenshots are files, so the block survives a reload.
    expect(existsSync(join(cwd, state.logPath))).toBe(true);
    const record = JSON.parse(
      await readFile(join(reviewRoundDir(cwd, state.slug, 1), "review.json"), "utf-8")
    ) as { verdict: string };
    expect(record.verdict).toBe("fail");
    // The model sees the same pixels the transcript will show.
    const images = result.content.filter((c) => c.type === "image");
    expect(images).toHaveLength(1);
  });

  it("records the phase the verdict implies, never a round counter", async () => {
    const cwd = await makeProject("phase");
    const state = await approvedState(cwd);
    const { execute } = harness(cwd, state);

    // A failing review means another build turn is coming.
    await execute("call-1", { verdict: "fail", punchlist: ["x"], url: "http://x" });
    expect((await loadDesignState(cwd, SESSION_ID))?.phase).toBe("revising");

    // A passing one clears it: there is nothing left to revise.
    await execute("call-2", { verdict: "pass", punchlist: [], url: "http://x" });
    const afterPass = await loadDesignState(cwd, SESSION_ID);
    expect(afterPass?.phase).toBeUndefined();
    // The rounds live in the review records, not in the state file.
    expect(JSON.stringify(afterPass)).not.toContain("round");
  });

  it("marks needs-user when the budget is spent", async () => {
    const cwd = await makeProject("needsuser");
    const state = await approvedState(cwd);
    const { execute } = harness(cwd, state);
    for (let round = 1; round <= JUDGE_MAX_ROUNDS; round++) {
      await execute(`call-${round}`, { verdict: "fail", punchlist: ["x"], url: "http://x" });
    }
    expect((await loadDesignState(cwd, SESSION_ID))?.phase).toBe("needs-user");
  });

  it("refuses to judge before the brief and direction are approved", async () => {
    const cwd = await makeProject("unapproved");
    const state = createDesignState("Sessions UI", "sessions-ui");
    await saveDesignState(cwd, SESSION_ID, state);
    const { calls, execute } = harness(cwd, state);
    await expect(execute("call-1", { verdict: "fail", punchlist: ["x"], url: "http://x" })).rejects.toThrow(
      /must be approved before reviewing/
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a passing verdict that still carries a punchlist", async () => {
    const cwd = await makeProject("contradiction");
    const state = await approvedState(cwd);
    const { execute } = harness(cwd, state);
    await expect(
      execute("call-1", { verdict: "pass", punchlist: ["still broken"], url: "http://x" })
    ).rejects.toThrow(/must not carry a punchlist/);
  });

  it("records a native round without pretending to capture", async () => {
    const cwd = await makeProject("native");
    const state = await approvedState(cwd, "native");
    const { calls, execute } = harness(cwd, state);
    const result = await execute("call-1", { verdict: "fail", punchlist: ["Tap target too small"] });
    expect(calls).toHaveLength(0);
    const details = result.details as { shots: unknown[]; punchlist: string[] };
    expect(details.shots).toEqual([]);
    expect(details.punchlist).toEqual(["Tap target too small"]);
  });

  it("stops judging at the round budget and tells the model to escalate", async () => {
    const cwd = await makeProject("budget");
    const state = await approvedState(cwd);
    const { execute } = harness(cwd, state);
    for (let round = 1; round <= JUDGE_MAX_ROUNDS; round++) {
      await execute(`call-${round}`, { verdict: "fail", punchlist: ["x"], url: "http://x" });
    }
    expect(await nextReviewRound(cwd, state.slug)).toBe(JUDGE_MAX_ROUNDS + 1);
    await expect(
      execute(`call-over`, { verdict: "fail", punchlist: ["x"], url: "http://x" })
    ).rejects.toThrow(/Escalate in plain chat/);
  });

  it("requires a URL for a web target rather than recording an uncapturable verdict", async () => {
    const cwd = await makeProject("nourl");
    const state = await approvedState(cwd);
    const { execute } = harness(cwd, state);
    await expect(execute("call-1", { verdict: "fail", punchlist: ["x"] })).rejects.toThrow(/url/i);
  });

  it("fails honestly when the runtime cannot capture", async () => {
    const cwd = await makeProject("nocapture");
    const state = await approvedState(cwd);
    const extension = createDesignModeExtension({
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      sendFollowUp: () => undefined,
    });
    const tool = extension.tools?.get("design_review");
    await expect(
      runTool(tool, { verdict: "fail", punchlist: ["x"], url: "http://x" })
    ).rejects.toThrow(/escalate in plain chat/i);
  });

  it("surfaces a capture failure instead of recording a verdict nobody can see", async () => {
    const cwd = await makeProject("capturefails");
    const state = await approvedState(cwd);
    const extension = createDesignModeExtension({
      getCwd: () => cwd,
      getSessionId: () => SESSION_ID,
      sendFollowUp: () => undefined,
      captureReview: vi.fn(async () => {
        throw new Error("no server detected");
      }),
    });
    const tool = extension.tools?.get("design_review");
    await expect(runTool(tool, { verdict: "fail", punchlist: ["x"], url: "http://x" })).rejects.toThrow(
      /no server detected/
    );
    // Nothing was recorded: a failed capture must not leave a review behind.
    expect(await nextReviewRound(cwd, state.slug)).toBe(1);
  });
});
