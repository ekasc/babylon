import { describe, expect, it, vi } from "vitest";
import { performSend, acquireSendExecution, type SendExecutionDeps, type SendExecutionInput } from "./send-execution";
import { mergeExecution } from "./view-navigation";
import type { ProjectExecution } from "../execution";

function exec(cwd: string, sessionFile: string, generation = 1): ProjectExecution {
  return { cwd, sessionFile, sessionId: `sid-${sessionFile}`, state: "idle", streaming: false, generation };
}

const busyResult = (file: string) => ({
  ok: false as const,
  code: "PROJECT_EXECUTION_BUSY" as const,
  busySessionFile: file,
  busySessionId: `sid-${file}`,
});

type SendBridge = SendExecutionDeps["bridge"];
/** One mock per bridge method, typed to the exact Send signature so the
 *  literal satisfies SendExecutionDeps without casts. */
type BridgeMock = { [K in keyof SendBridge]-?: ReturnType<typeof vi.fn<SendBridge[K]>> } & {
  /** Not part of the Send Pick — test 15 proves Send never consults it. */
  onStatus: ReturnType<typeof vi.fn>;
};

function makeBridge(over: Partial<BridgeMock> = {}): BridgeMock {
  return {
    executionActivate: vi.fn<SendBridge["executionActivate"]>(async (cwd, sessionFile) => ({
      ok: true as const,
      execution: exec(cwd, sessionFile ?? "/s/b"),
    })),
    prompt: vi.fn<SendBridge["prompt"]>(async () => undefined),
    beginGoalPrompt: vi.fn<SendBridge["beginGoalPrompt"]>(async () => ({ goal: null, started: true, error: null })),
    beginDesignPrompt: vi.fn<SendBridge["beginDesignPrompt"]>(async () => ({
      design: null,
      stage: "elicit" as const,
      started: true,
      error: null,
    })),
    groupSend: vi.fn<SendBridge["groupSend"]>(async () => ({ rounds: 1, turns: 1, spoke: 1, stopped: false })),
    onStatus: vi.fn(),
    ...over,
  };
}

type MockDepKeys =
  | "setPreparingTurn"
  | "onActivated"
  | "rollbackOptimistic"
  | "hydrateIfRollback"
  | "busyToast"
  | "activationFailedToast"
  | "onGoalSubmit"
  | "onDesignSubmit";
type DepMocks = { [K in MockDepKeys]-?: ReturnType<typeof vi.fn<NonNullable<SendExecutionDeps[K]>>> };

interface DepConfig {
  bridge?: BridgeMock;
  roomGroupId?: string | null;
  goalArmed?: boolean;
  designArmed?: boolean;
  viewedPathRef?: { current: string | null };
}

function makeDeps(config: DepConfig = {}) {
  const mocks: DepMocks = {
    setPreparingTurn: vi.fn<NonNullable<SendExecutionDeps["setPreparingTurn"]>>(),
    onActivated: vi.fn<NonNullable<SendExecutionDeps["onActivated"]>>(),
    rollbackOptimistic: vi.fn<NonNullable<SendExecutionDeps["rollbackOptimistic"]>>(),
    hydrateIfRollback: vi.fn<NonNullable<SendExecutionDeps["hydrateIfRollback"]>>(),
    busyToast: vi.fn<NonNullable<SendExecutionDeps["busyToast"]>>(),
    activationFailedToast: vi.fn<NonNullable<SendExecutionDeps["activationFailedToast"]>>(),
    onGoalSubmit: vi.fn<NonNullable<SendExecutionDeps["onGoalSubmit"]>>(),
    onDesignSubmit: vi.fn<NonNullable<SendExecutionDeps["onDesignSubmit"]>>(),
  };
  const deps = {
    ...mocks,
    bridge: config.bridge ?? makeBridge(),
    roomGroupId: config.roomGroupId ?? null,
    goalArmed: config.goalArmed ?? false,
    designArmed: config.designArmed ?? false,
    viewedPathRef: config.viewedPathRef ?? { current: "/s/b" },
  };
  return { deps, mocks };
}

const input: SendExecutionInput = { cwd: "/p", target: "/s/b", text: "hello" };

describe("performSend: execution acquisition then exactly one turn", () => {
  it("1: no owner — activates (cwd, B), prompts B, merges B into the registry", async () => {
    const bridge = makeBridge();
    const { deps, mocks } = makeDeps({ bridge });
    const stage = await performSend(deps, input);
    expect(stage).toEqual({ stage: "prompted" });
    expect(bridge.executionActivate).toHaveBeenCalledWith("/p", "/s/b");
    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    expect(bridge.prompt).toHaveBeenCalledWith("hello", undefined, undefined, "/s/b");
    expect(mocks.onActivated).toHaveBeenCalledWith(expect.objectContaining({ sessionFile: "/s/b" }));
    // preparingTurn covered activation only.
    expect(mocks.setPreparingTurn.mock.calls.flat()).toEqual([true, false]);
  });

  it("2: B already owns — activation succeeds once, prompt(B) exactly once", async () => {
    const bridge = makeBridge();
    const { deps } = makeDeps({ bridge });
    await performSend(deps, input);
    expect(bridge.executionActivate).toHaveBeenCalledTimes(1);
    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    expect(bridge.prompt).toHaveBeenCalledWith("hello", undefined, undefined, "/s/b");
  });

  it("3: idle A owner — activation transfers A→B (backend), prompt only to B", async () => {
    // The renderer just sees ok + B's execution with a bumped generation;
    // PiHost performs check/release/open/mapping internally — never two
    // renderer-orchestrated calls (deactivate + activate).
    const bridge = makeBridge({
      executionActivate: vi.fn<SendBridge["executionActivate"]>(async (cwd) => ({
        ok: true as const,
        execution: exec(cwd ?? "/p", "/s/b", 2),
      })),
    });
    const { deps, mocks } = makeDeps({ bridge });
    const stage = await performSend(deps, input);
    expect(stage.stage).toBe("prompted");
    expect(mocks.onActivated).toHaveBeenCalledWith(expect.objectContaining({ sessionFile: "/s/b", generation: 2 }));
    expect(bridge.prompt).toHaveBeenCalledTimes(1);
    expect(bridge.prompt).toHaveBeenCalledWith("hello", undefined, undefined, "/s/b");
    expect(bridge.executionActivate).toHaveBeenCalledTimes(1);
  });

  it("4: busy A owner — no prompt, no merge, rollback + hydrate + busy toast; ownership untouched", async () => {
    const bridge = makeBridge({
      executionActivate: vi.fn<SendBridge["executionActivate"]>(async () => busyResult("/s/a")),
    });
    const { deps, mocks } = makeDeps({ bridge });
    const stage = await performSend(deps, input);
    expect(stage).toEqual({ stage: "busy", busySessionFile: "/s/a", busySessionId: "sid-/s/a" });
    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(bridge.beginGoalPrompt).not.toHaveBeenCalled();
    expect(mocks.onActivated).not.toHaveBeenCalled(); // local registry unchanged (A stays owner)
    expect(mocks.rollbackOptimistic).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateIfRollback).toHaveBeenCalledTimes(1);
    expect(mocks.busyToast).toHaveBeenCalledWith("/s/a");
  });

  it("5: cross-project — A running in project A never blocks Send B in project B", async () => {
    const bridge = makeBridge();
    const { deps, mocks } = makeDeps({ bridge });
    await performSend(deps, { cwd: "/proj-b", target: "/s/b1", text: "hi" });
    expect(bridge.executionActivate).toHaveBeenCalledWith("/proj-b", "/s/b1");
    expect(bridge.prompt).toHaveBeenCalledWith("hi", undefined, undefined, "/s/b1");
    expect(mocks.onActivated).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/proj-b" }));
  });

  it("6: navigating to C while activation awaits — the prompt still targets B (I7)", async () => {
    let release!: (v: Awaited<ReturnType<SendBridge["executionActivate"]>>) => void;
    const bridge = makeBridge({
      executionActivate: vi.fn<SendBridge["executionActivate"]>(() => new Promise((r) => (release = r))),
    });
    const { deps } = makeDeps({ bridge }); // viewedPathRef starts at "/s/b"
    const pending = performSend(deps, input);
    // The user views C mid-activation; presentation changes, identity does not.
    deps.viewedPathRef.current = "/s/c";
    release({ ok: true, execution: exec("/p", "/s/b") });
    const stage = await pending;
    expect(stage.stage).toBe("prompted");
    expect(bridge.prompt).toHaveBeenCalledWith("hello", undefined, undefined, "/s/b");
  });

  it("7: activation ok + prompt failure — rollback, hydrate, throw; B keeps ownership", async () => {
    const bridge = makeBridge({
      prompt: vi.fn<SendBridge["prompt"]>(async () => {
        throw new Error("network");
      }),
    });
    const { deps, mocks } = makeDeps({ bridge });
    await expect(performSend(deps, input)).rejects.toThrow("network");
    expect(mocks.onActivated).toHaveBeenCalledTimes(1); // merged before the turn — ownership stands
    expect(mocks.rollbackOptimistic).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateIfRollback).toHaveBeenCalledTimes(1);
  });

  it("8: armed Goal — activation first, beginGoalPrompt(B), ordinary prompt never called", async () => {
    const bridge = makeBridge();
    const { deps, mocks } = makeDeps({ bridge, goalArmed: true });
    const stage = await performSend(deps, input);
    expect(stage.stage).toBe("goal");
    expect(bridge.executionActivate.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.beginGoalPrompt.mock.invocationCallOrder[0]!
    );
    expect(mocks.onActivated.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.beginGoalPrompt.mock.invocationCallOrder[0]!
    );
    expect(mocks.onGoalSubmit).toHaveBeenCalledTimes(1);
    expect(bridge.beginGoalPrompt).toHaveBeenCalledWith("/s/b", "hello", "hello", undefined, undefined);
    expect(bridge.prompt).not.toHaveBeenCalled();
  });

  it("9: busy owner + armed Goal — beginGoalPrompt never called, row rolled back, no goal state", async () => {
    const bridge = makeBridge({
      executionActivate: vi.fn<SendBridge["executionActivate"]>(async () => busyResult("/s/a")),
    });
    const { deps, mocks } = makeDeps({ bridge, goalArmed: true });
    const stage = await performSend(deps, input);
    expect(stage.stage).toBe("busy");
    expect(bridge.beginGoalPrompt).not.toHaveBeenCalled();
    expect(mocks.onGoalSubmit).not.toHaveBeenCalled(); // arming untouched → no pending goal state
    expect(mocks.rollbackOptimistic).toHaveBeenCalledTimes(1);
  });

  it("10: armed Design — activation first, beginDesignPrompt(B), prompt never called", async () => {
    const bridge = makeBridge();
    const { deps, mocks } = makeDeps({ bridge, designArmed: true });
    const stage = await performSend(deps, input);
    expect(stage.stage).toBe("design");
    expect(mocks.onDesignSubmit).toHaveBeenCalledTimes(1);
    expect(bridge.beginDesignPrompt).toHaveBeenCalledWith("/s/b", "hello", "hello", undefined, undefined);
    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(bridge.executionActivate.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.beginDesignPrompt.mock.invocationCallOrder[0]!
    );
  });

  it("11: busy owner + armed Design — beginDesignPrompt never called", async () => {
    const bridge = makeBridge({
      executionActivate: vi.fn<SendBridge["executionActivate"]>(async () => busyResult("/s/a")),
    });
    const { deps, mocks } = makeDeps({ bridge, designArmed: true });
    const stage = await performSend(deps, input);
    expect(stage.stage).toBe("busy");
    expect(bridge.beginDesignPrompt).not.toHaveBeenCalled();
    expect(mocks.onDesignSubmit).not.toHaveBeenCalled();
    expect(mocks.rollbackOptimistic).toHaveBeenCalledTimes(1);
  });

  it("12: room send — acquisition for the room session happens before groupSend", async () => {
    const bridge = makeBridge();
    const { deps } = makeDeps({ bridge, roomGroupId: "grp-1" });
    const stage = await performSend(deps, input);
    expect(stage.stage).toBe("group");
    // Room session = viewed target; groupSend receives the group id.
    expect(bridge.executionActivate).toHaveBeenCalledWith("/p", "/s/b");
    expect(bridge.executionActivate.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.groupSend.mock.invocationCallOrder[0]!
    );
    expect(bridge.groupSend).toHaveBeenCalledWith("grp-1", "hello");
    expect(bridge.prompt).not.toHaveBeenCalled();
  });

  it("13: activation transport failure — no prompt, rollback, error surfaced", async () => {
    const bridge = makeBridge({
      executionActivate: vi.fn<SendBridge["executionActivate"]>(async () => {
        throw new Error("ipc down");
      }),
    });
    const { deps, mocks } = makeDeps({ bridge });
    const stage = await performSend(deps, input);
    expect(stage).toEqual({ stage: "activation-failed" });
    expect(bridge.prompt).not.toHaveBeenCalled();
    expect(mocks.onActivated).not.toHaveBeenCalled();
    expect(mocks.rollbackOptimistic).toHaveBeenCalledTimes(1);
    expect(mocks.activationFailedToast).toHaveBeenCalledTimes(1);
    const surfaced = mocks.activationFailedToast.mock.calls[0]?.[0] as Error;
    expect(surfaced).toBeInstanceOf(Error);
    expect(surfaced.message).toMatch(/ipc down/);
    expect(mocks.setPreparingTurn.mock.calls.flat()).toEqual([true, false]);
  });

  it("14: activation merge is immediate and a duplicate same-generation push is a no-op", async () => {
    const bridge = makeBridge();
    const { deps, mocks } = makeDeps({ bridge });
    let registry: Record<string, ProjectExecution> = {};
    mocks.onActivated.mockImplementation((e: ProjectExecution) => {
      registry = mergeExecution(registry, e);
    });
    await performSend(deps, input);
    expect(registry["/p"]?.sessionFile).toBe("/s/b");
    // The eventual pideck_execution_changed echo (same generation) does not
    // regress or duplicate the synchronously-merged record.
    const before = registry["/p"];
    registry = mergeExecution(registry, exec("/p", "/s/b", 1));
    expect(registry["/p"]).toEqual(before);
    // A stale older generation cannot roll ownership back either.
    registry = mergeExecution(registry, { ...exec("/p", "/s/old"), generation: 0 });
    expect(registry["/p"]?.sessionFile).toBe("/s/b");
  });

  it("15: historical B with liveReady=false — executionActivate is the only warmup; onStatus never consulted", async () => {
    const bridge = makeBridge();
    const { deps } = makeDeps({ bridge });
    const stage = await performSend(deps, input);
    expect(stage.stage).toBe("prompted");
    // The legacy readiness channel has no role in the Send contract.
    expect(bridge.onStatus).not.toHaveBeenCalled();
    expect(bridge.executionActivate).toHaveBeenCalledTimes(1);
  });

  it("steer/followUp in a room bypasses groupSend and prompts the room session directly", async () => {
    const bridge = makeBridge();
    const { deps } = makeDeps({ bridge, roomGroupId: "grp-1" });
    const stage = await performSend(deps, { ...input, streamingBehavior: "steer" });
    expect(stage.stage).toBe("prompted");
    expect(bridge.groupSend).not.toHaveBeenCalled();
    expect(bridge.prompt).toHaveBeenCalledWith("hello", undefined, "steer", "/s/b");
  });
});

describe("acquireSendExecution", () => {
  it("passes cwd/sessionFile through untouched", async () => {
    const bridge = makeBridge();
    await acquireSendExecution(bridge, "/p", "/s/b");
    expect(bridge.executionActivate).toHaveBeenCalledWith("/p", "/s/b");
  });
});
