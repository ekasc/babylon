import { describe, expect, it } from "vitest";
import {
  activeThreadAnchorTimestampMs,
  getLatestThreadForProject,
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
} from "./threadSort";

describe("toSortableTimestamp", () => {
  it("parses iso", () => {
    expect(toSortableTimestamp("2024-01-01T00:00:00Z")).toBe(Date.parse("2024-01-01T00:00:00Z"));
  });
  it("returns null for invalid", () => {
    expect(toSortableTimestamp("not-a-date")).toBeNull();
  });
});

describe("getThreadSortTimestamp", () => {
  it("uses latestUserMessageAt when present", () => {
    const t = { createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z", latestUserMessageAt: "2024-01-03T00:00:00Z" };
    expect(getThreadSortTimestamp(t, "latest")).toBe(Date.parse("2024-01-03T00:00:00Z"));
  });
  it("falls back to updatedAt/createdAt", () => {
    const t = { createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z" };
    expect(getThreadSortTimestamp(t, "created_at")).toBe(Date.parse("2024-01-01T00:00:00Z"));
  });
});

describe("activeThreadAnchorTimestampMs", () => {
  it("max of createdAt and unsettledAt", () => {
    expect(
      activeThreadAnchorTimestampMs({ createdAt: "2024-01-01T00:00:00Z", unsettledAt: "2024-01-05T00:00:00Z" }),
    ).toBe(Date.parse("2024-01-05T00:00:00Z"));
  });
});

describe("sortThreads", () => {
  it("sorts by latest timestamp desc", () => {
    const threads = [
      { id: "a", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
      { id: "b", createdAt: "2024-01-03T00:00:00Z", updatedAt: "2024-01-03T00:00:00Z" },
      { id: "c", createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z" },
    ];
    expect(sortThreads(threads).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("getLatestThreadForProject", () => {
  it("returns latest non-archived", () => {
    const threads = [
      { id: "a", projectId: "p1", archivedAt: null, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
      { id: "b", projectId: "p1", archivedAt: "2024-01-02T00:00:00Z", createdAt: "2024-01-03T00:00:00Z", updatedAt: "2024-01-03T00:00:00Z" },
      { id: "c", projectId: "p2", archivedAt: null, createdAt: "2024-01-04T00:00:00Z", updatedAt: "2024-01-04T00:00:00Z" },
    ];
    expect(getLatestThreadForProject(threads as any, "p1")?.id).toBe("a");
  });
});
