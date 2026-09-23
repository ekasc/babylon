// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { bridge, type ProjectGroup } from "../../bridge";
import { useGitStatus } from "./useGitStatus";

function groupsFor(...cwds: string[]): ProjectGroup[] {
  return cwds.map((cwd) => ({ cwd, sessions: [] }));
}

describe("useGitStatus", () => {
  it("does not refire when session emissions hand over fresh array identities with the same cwds", async () => {
    const spy = vi
      .spyOn(bridge, "gitStatus")
      .mockResolvedValue({ isRepo: false, dirty: [], ahead: 0, behind: 0 });
    try {
      const { rerender, unmount } = renderHook(({ groups }) => useGitStatus(groups), {
        initialProps: { groups: groupsFor("/a", "/b") },
      });
      await act(async () => {});
      expect(spy).toHaveBeenCalledTimes(2);

      // New array + new group objects every emission (what the session index
      // does while streaming), but the same cwd set: no new spawns.
      rerender({ groups: groupsFor("/a", "/b") });
      await act(async () => {});
      rerender({ groups: groupsFor("/b", "/a") });
      await act(async () => {});
      expect(spy).toHaveBeenCalledTimes(2);

      // A genuinely new project does trigger a pass, covering the new cwd.
      rerender({ groups: groupsFor("/a", "/b", "/c") });
      await act(async () => {});
      expect(spy.mock.calls.map((call) => call[0])).toContain("/c");
      unmount();
    } finally {
      spy.mockRestore();
    }
  });

  it("publishes per-cwd results into state", async () => {
    const spy = vi.spyOn(bridge, "gitStatus").mockImplementation(async (cwd: string) => ({
      isRepo: true,
      root: cwd,
      branch: "main",
      dirty: [],
      ahead: 0,
      behind: 0,
    }));
    try {
      const { result, unmount } = renderHook(({ groups }) => useGitStatus(groups), {
        initialProps: { groups: groupsFor("/a") },
      });
      await act(async () => {});
      expect(result.current.gitStatuses["/a"]?.branch).toBe("main");
      unmount();
    } finally {
      spy.mockRestore();
    }
  });
});
