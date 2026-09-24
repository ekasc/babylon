import { describe, expect, it, vi } from "vitest";
import { createDaemonRuntime } from "./daemon-runtime";
import { createEnvelope, type ProtocolEnvelope, type ProtocolMessageType, type ProtocolPayload } from "./daemon-protocol";
import type { DaemonClient } from "./daemon-client";
import type { ProjectExecution } from "./execution";

const execution = (cwd: string, sessionFile: string, sessionId: string): ProjectExecution => ({
  cwd,
  sessionFile,
  sessionId,
  state: "idle",
  streaming: false,
  generation: 1,
});

function fakeClient(owners: ProjectExecution[]): DaemonClient {
  return {
    request: vi.fn(async (type: ProtocolMessageType, payload: ProtocolPayload): Promise<ProtocolEnvelope> => {
      if (type === "pi.executionList") {
        return createEnvelope("response", "pi.executionList", { executions: owners }, payload.requestId as string);
      }
      throw new Error(`unexpected request ${type}`);
    }),
    onEvent: () => () => undefined,
    close: () => undefined,
  } as unknown as DaemonClient;
}

describe("daemon execution ownership lookups", () => {
  it("answers executionCwdFor from the daemon's own registry, with no local host", async () => {
    // In daemon mode there is NO local PiHost: identity must come from the
    // execution registry, or addressed mutations (worktree create) break.
    const rt = createDaemonRuntime(fakeClient([execution("/p1", "/a.json", "sA"), execution("/p2", "/c.json", "sC")]));
    expect(await rt.executionCwdFor("/a.json")).toBe("/p1");
    expect(await rt.executionCwdFor("/c.json")).toBe("/p2");
  });

  it("returns null for a file that owns no project", async () => {
    const rt = createDaemonRuntime(fakeClient([execution("/p1", "/a.json", "sA")]));
    expect(await rt.executionCwdFor("/historical.json")).toBeNull();
  });
});
