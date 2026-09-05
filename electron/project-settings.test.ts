import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectSettingsStore, projectHashForCwd } from "./project-settings";

const APP_DEFAULT = { name: "Assistant", persona: "Be helpful." };

function tempStore(): ProjectSettingsStore {
  return new ProjectSettingsStore(mkdtempSync(join(tmpdir(), "babylon-projects-")));
}

describe("projectHashForCwd", () => {
  it("is stable and ignores trailing slashes", () => {
    expect(projectHashForCwd("/repo")).toBe(projectHashForCwd("/repo/"));
    expect(projectHashForCwd("/repo")).toMatch(/^[0-9a-f]{24}$/);
    expect(projectHashForCwd("/repo")).not.toBe(projectHashForCwd("/other"));
  });
});

describe("project settings store", () => {
  it("snapshots the app-default on first open and reuses it after", () => {
    const store = tempStore();
    const first = store.getOrCreate("/repo", APP_DEFAULT);
    expect(first.created).toBe(true);
    expect(first.settings.defaultBot).toEqual(APP_DEFAULT);
    expect(first.settings.memberIds).toEqual([]);
    expect(first.settings.freeSpeak).toBe(false);

    const second = store.getOrCreate("/repo/", APP_DEFAULT);
    expect(second.created).toBe(false);
    expect(second.hash).toBe(first.hash);
  });

  it("persists across reopen and validates the default copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "babylon-projects-"));
    const s1 = new ProjectSettingsStore(dir);
    const created = s1.getOrCreate("/repo", APP_DEFAULT);
    s1.setFreeSpeak(created.hash, true);

    const s2 = new ProjectSettingsStore(dir);
    expect(s2.get("/repo")?.freeSpeak).toBe(true);
    expect(() => s2.updateDefaultBot(created.hash, { name: "  " })).toThrow();
    const updated = s2.updateDefaultBot(created.hash, { persona: "Be terse." });
    expect(updated.defaultBot.persona).toBe("Be terse.");
    expect(s2.resetDefaultBot(created.hash, APP_DEFAULT).defaultBot).toEqual(APP_DEFAULT);
  });

  it("dedupes staffed members and rejects unknown projects", () => {
    const store = tempStore();
    const created = store.getOrCreate("/repo", APP_DEFAULT);
    expect(store.setMembers(created.hash, ["a", "a", "b"]).memberIds).toEqual(["a", "b"]);
    expect(() => store.setFreeSpeak("0".repeat(24), true)).toThrow(/not found/);
  });
});
