import { describe, expect, it, vi } from "vitest";
import {
  deriveComposerExecutionAccess,
  deriveViewedStreaming,
  executionBusyLabel,
  returnToExecution,
} from "./composer-execution";
import type { ProjectExecution } from "../execution";

function execution(file: string, over: Partial<ProjectExecution> = {}): ProjectExecution {
  return {
    cwd: "/p",
    sessionFile: file,
    sessionId: `sid-${file}`,
    state: "idle",
    streaming: false,
    generation: 1,
    ...over,
  };
}

const B = "/s/b";
const A = "/s/a";

describe("deriveComposerExecutionAccess table", () => {
  it("no owner + viewed B -> claimable", () => {
    expect(
      deriveComposerExecutionAccess({ viewedSessionPath: B, currentExecution: null, ownerExecutionState: null })
    ).toEqual({ kind: "claimable" });
  });

  it("owner B + viewed B + working -> owner (the owner keeps full controls even while busy)", () => {
    expect(
      deriveComposerExecutionAccess({
        viewedSessionPath: B,
        currentExecution: execution(B, { state: "working", streaming: true }),
        ownerExecutionState: "working",
      })
    ).toEqual({ kind: "owner" });
  });

  it("owner A + viewed B + idle -> claimable", () => {
    expect(
      deriveComposerExecutionAccess({
        viewedSessionPath: B,
        currentExecution: execution(A, { state: "idle" }),
        ownerExecutionState: "idle",
      })
    ).toEqual({ kind: "claimable" });
  });

  it("owner A + viewed B + failed -> claimable (failed owners may be replaced)", () => {
    expect(
      deriveComposerExecutionAccess({
        viewedSessionPath: B,
        currentExecution: execution(A, { state: "failed" }),
        ownerExecutionState: "failed",
      })
    ).toEqual({ kind: "claimable" });
  });

  it("owner A + viewed B + working -> blocked with A's identity", () => {
    expect(
      deriveComposerExecutionAccess({
        viewedSessionPath: B,
        currentExecution: execution(A, { state: "working", streaming: true }),
        ownerExecutionState: "working",
      })
    ).toEqual({ kind: "blocked", ownerSessionFile: A, ownerSessionId: "sid-/s/a" });
  });

  it("owner A + viewed B + waiting -> blocked", () => {
    expect(
      deriveComposerExecutionAccess({
        viewedSessionPath: B,
        currentExecution: execution(A, { state: "waiting" }),
        ownerExecutionState: "waiting",
      }).kind
    ).toBe("blocked");
  });

  it("owner A + viewed B + approval -> blocked", () => {
    expect(
      deriveComposerExecutionAccess({
        viewedSessionPath: B,
        currentExecution: execution(A, { state: "approval" }),
        ownerExecutionState: "approval",
      }).kind
    ).toBe("blocked");
  });

  it("automatic unlock: same inputs minus live state flip blocked -> claimable with no navigation", () => {
    // A working while B viewed: blocked. A's runtime event settles it to
    // idle (runtimeByPath updates; registry unchanged): claimable. Pure —
    // the selector performs no side effects of any kind.
    const current = execution(A, { state: "working", streaming: true });
    expect(
      deriveComposerExecutionAccess({ viewedSessionPath: B, currentExecution: current, ownerExecutionState: "working" }).kind
    ).toBe("blocked");
    expect(
      deriveComposerExecutionAccess({ viewedSessionPath: B, currentExecution: current, ownerExecutionState: "idle" }).kind
    ).toBe("claimable");
    // Registry fallback (no live observation yet) still resolves from state.
    expect(
      deriveComposerExecutionAccess({ viewedSessionPath: B, currentExecution: { ...current, state: "idle" }, ownerExecutionState: null }).kind
    ).toBe("claimable");
  });
});

describe("executionBusyLabel", () => {
  it("phrases each busy state distinctly; approval reads as attention", () => {
    expect(executionBusyLabel("working")).toBe("is working");
    expect(executionBusyLabel("waiting")).toBe("is waiting");
    expect(executionBusyLabel("approval")).toBe("needs approval");
  });
});

describe("deriveViewedStreaming", () => {
  it("27: A streaming while B is viewed hides all stream controls from B", () => {
    expect(deriveViewedStreaming(false, true)).toBe(false);
  });
  it("owner streaming stays visible", () => {
    expect(deriveViewedStreaming(true, true)).toBe(true);
    expect(deriveViewedStreaming(true, false)).toBe(false);
  });
});

describe("returnToExecution", () => {
  function makeDeps(currentExecution: ProjectExecution | null) {
    const bridge = {
      openSession: vi.fn(),
      executionActivate: vi.fn(),
      releaseSession: vi.fn(),
    };
    const viewSession = vi.fn();
    const onBeforeView = vi.fn();
    return { deps: { currentExecution, viewSession, bridge, onBeforeView }, bridge, viewSession, onBeforeView };
  }

  it("26: views the CURRENT owner via viewSession only — never activation APIs", () => {
    const owner = execution(A, { state: "working", streaming: true });
    const { deps, bridge, viewSession, onBeforeView } = makeDeps(owner);
    expect(returnToExecution(deps)).toBe(true);
    expect(onBeforeView).toHaveBeenCalledTimes(1);
    expect(viewSession).toHaveBeenCalledWith(A, "/p");
    expect(viewSession).toHaveBeenCalledTimes(1);
    // Navigation invariant: no open/activate/release from Return to live.
    expect(bridge.openSession).not.toHaveBeenCalled();
    expect(bridge.executionActivate).not.toHaveBeenCalled();
    expect(bridge.releaseSession).not.toHaveBeenCalled();
  });

  it("uses the execution passed in — ownership changes between renders are honored", () => {
    const { deps, viewSession } = makeDeps(execution("/s/new-owner", { state: "working" }));
    returnToExecution(deps);
    expect(viewSession).toHaveBeenCalledWith("/s/new-owner", "/p");
  });

  it("no owner: no navigation of any kind", () => {
    const { deps, bridge, viewSession } = makeDeps(null);
    expect(returnToExecution(deps)).toBe(false);
    expect(viewSession).not.toHaveBeenCalled();
    expect(bridge.openSession).not.toHaveBeenCalled();
  });
});
