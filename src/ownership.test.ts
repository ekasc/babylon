import { describe, expect, it } from "vitest";
import { describeOwner, requireOwners, sameOwner, stampOwnership } from "./ownership";

describe("stable ownership", () => {
  it("drops blank values when stamping", () => {
    const stamp = stampOwnership({ taskId: "t1", sessionId: "  ", agentId: undefined });
    expect(stamp).toEqual({ taskId: "t1" });
  });

  it("throws listing every missing required id", () => {
    const stamp = stampOwnership({ sessionId: "s1" });
    expect(() => requireOwners(stamp, ["sessionId"])).not.toThrow();
    expect(() => requireOwners(stamp, ["taskId", "processId", "sessionId"])).toThrow(
      /missing required ownership: taskId, processId/
    );
  });

  it("compares only keys both stamps mention", () => {
    expect(sameOwner({ taskId: "t1" }, { taskId: "t1", sessionId: "s1" })).toBe(true);
    expect(sameOwner({ taskId: "t1" }, { taskId: "t2" })).toBe(false);
  });

  it("describes stamps readably and flags unowned ones", () => {
    expect(describeOwner({ taskId: "t1", sessionId: "s7" })).toBe("task=t1 session=s7");
    expect(describeOwner({})).toBe("unowned");
  });
});
