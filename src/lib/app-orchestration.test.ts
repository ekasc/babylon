import { describe, expect, it } from "vitest";
import {
  applyRuntimeStatus,
  projectFocusTarget,
  groupChatCwd,
  isViewedEvent,
  projectSettingsCwd,
  reconnectExecutions,
} from "./app-orchestration";
import type { ProjectExecution } from "../execution";
import type { RuntimeStatus } from "../bridge";

const owner = (cwd: string, sessionFile: string): ProjectExecution => ({
  cwd,
  sessionFile,
  sessionId: `sid-${sessionFile}`,
  state: "working",
  streaming: true,
  generation: 1,
});

describe("runtime health carries no identity", () => {
  it("reports health and errors, and has no session/project field to set", () => {
    const ready = applyRuntimeStatus({ status: "starting" }, { status: "ready" });
    expect(ready).toEqual({ status: { status: "ready" }, errorMessage: null });

    const failed = applyRuntimeStatus({ status: "ready" }, { status: "error", message: "boom" });
    expect(failed.status.status).toBe("error");
    expect(failed.errorMessage).toBe("boom");
  });
});

describe("runtime health cannot navigate", () => {
  it("drops a session identity smuggled in through a health payload", () => {
    // Even if a runtime status somehow carries a session, the policy has no
    // field to put it in: the outcome is health, and nothing else.
    const smuggled = { status: "ready", sessionFile: "/a.json", cwd: "/p" } as unknown as RuntimeStatus;
    const outcome = applyRuntimeStatus({ status: "starting" }, smuggled);
    expect(Object.keys(outcome).sort()).toEqual(["errorMessage", "status"]);
    expect(outcome.status).toEqual({ status: "ready" });
  });
});

describe("project settings follow the active project", () => {
  it("uses activeSpace and nothing else", () => {
    expect(projectSettingsCwd("/p")).toBe("/p");
    expect(projectSettingsCwd(null)).toBeNull();
  });

  it("has no second source to fall back to", () => {
    // Called through a widened signature on purpose: a runtime cwd passed in
    // from anywhere must not become the project.
    const widen = projectSettingsCwd as (space: string | null, statusCwd?: string | null) => string | null;
    expect(widen(null, "/status")).toBeNull();
    expect(widen("/p", "/status")).toBe("/p");
  });
});

describe("group chat context", () => {
  it("prefers the group's own project, then a member, then the filter, then the active project", () => {
    expect(groupChatCwd({ groupCwd: "/g", memberCwd: "/m", projectFilter: "/f", activeSpace: "/a" })).toBe("/g");
    expect(groupChatCwd({ memberCwd: "/m", projectFilter: "/f", activeSpace: "/a" })).toBe("/m");
    expect(groupChatCwd({ projectFilter: "/f", activeSpace: "/a" })).toBe("/f");
    expect(groupChatCwd({ projectFilter: "all", activeSpace: "/a" })).toBe("/a");
    expect(groupChatCwd({ projectFilter: "all", activeSpace: null })).toBeNull();
  });
});

describe("reconnect keeps every project owner", () => {
  it("clears event-only rows and rehydrates the viewed session only if it owns its project", () => {
    const owners = [owner("/p1", "/a.json"), owner("/p2", "/c.json")];
    const viewed = reconnectExecutions(owners, "/a.json");
    expect(viewed.clearEventState).toBe(true);
    expect(viewed.rehydratePath).toBe("/a.json");

    // Viewing a historical session in P1 while P1's owner is elsewhere:
    // no rehydration, and both owners still stand.
    const historical = reconnectExecutions(owners, "/b.json");
    expect(historical.rehydratePath).toBeNull();
    expect(owners).toHaveLength(2);

    // Nothing viewed, nothing to hydrate.
    expect(reconnectExecutions(owners, null).rehydratePath).toBeNull();
  });
});

describe("view-scoped event side effects", () => {
  it("apply only to the event that names the viewed conversation", () => {
    expect(isViewedEvent("/b.json", "/b.json")).toBe(true);
    // A settles in the background while B is on screen: no viewed-side work.
    expect(isViewedEvent("/a.json", "/b.json")).toBe(false);
    // Landing: nothing is viewed, so nothing is view-scoped.
    expect(isViewedEvent("/a.json", null)).toBe(false);
    expect(isViewedEvent(null, "/b.json")).toBe(false);
  });
});

describe("project focus target", () => {
  it("is the active Space, and null clears it", () => {
    expect(projectFocusTarget("/p")).toBe("/p");
    expect(projectFocusTarget(null)).toBeNull();
  });
});
