import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotStore } from "./bots";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "babylon-bots-")), "bots.json");
}

describe("babylon bot store", () => {
  it("creates, updates, and persists bots", () => {
    const path = tempPath();
    const store = new BotStore(path);
    expect(store.list()).toHaveLength(0);
    const created = store.create({ name: "Reviewer", title: "Security reviewer", persona: "Be terse." });
    expect(created.mainSessionFile).toBeNull();
    expect(store.resolve("@reviewer")?.id).toBe(created.id);

    const updated = store.update(created.id, { cwd: "/tmp/proj", hidden: true });
    expect(updated.cwd).toBe("/tmp/proj");
    expect(updated.hidden).toBe(true);

    const reopened = new BotStore(path);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get(created.id)?.title).toBe("Security reviewer");
  });

  it("rejects duplicate names case-insensitively", () => {
    const store = new BotStore(tempPath());
    store.create({ name: "Reviewer" });
    expect(() => store.create({ name: "reviewer" })).toThrow(/already exists/);
    const other = store.create({ name: "Researcher" });
    expect(() => store.update(other.id, { name: "REVIEWER" })).toThrow(/already exists/);
  });

  it("finds bots by canonical session file and tracks main session", () => {
    const store = new BotStore(tempPath());
    const created = store.create({ name: "Reviewer" });
    expect(store.findBySessionFile("/s/1.jsonl")).toBeUndefined();
    store.setMainSession(created.id, "/s/1.jsonl");
    expect(store.findBySessionFile("/s/1.jsonl")?.id).toBe(created.id);
  });

  it("treats corrupt files as empty and removes cleanly", () => {
    const path = tempPath();
    const store = new BotStore(path);
    store.create({ name: "Reviewer" });
    require("node:fs").writeFileSync(path, "{not json", "utf8");
    expect(new BotStore(path).list()).toHaveLength(0);
    const fresh = new BotStore(tempPath());
    const created = fresh.create({ name: "Temp" });
    expect(fresh.remove(created.id)).toBe(true);
    expect(fresh.list()).toHaveLength(0);
  });

  it("manages groups with member validation", () => {
    const store = new BotStore(tempPath());
    const a = store.create({ name: "Reviewer" });
    const b = store.create({ name: "Researcher" });
    expect(() => store.createGroup({ name: "Squad", memberIds: [a.id] })).toThrow(/at least 2/);
    expect(() => store.createGroup({ name: "Squad", memberIds: [a.id, "nope"] })).toThrow(/existing bots/);
    const group = store.createGroup({ name: "Squad", memberIds: [a.id, b.id] });
    expect(group.mainSessionFile).toBeNull();
    expect(store.findGroupBySessionFile("/g/1.jsonl")).toBeUndefined();
    store.setGroupRoom(group.id, "/g/1.jsonl");
    expect(store.findGroupBySessionFile("/g/1.jsonl")?.id).toBe(group.id);
    expect(() => store.createGroup({ name: "squad", memberIds: [a.id, b.id] })).toThrow(/already exists/);
    const renamed = store.updateGroup(group.id, { name: "Crew" });
    expect(renamed.name).toBe("Crew");
    expect(() => store.updateGroup(group.id, { memberIds: [a.id] })).toThrow(/at least 2/);
    expect(store.removeGroup(group.id)).toBe(true);
    expect(store.listGroups()).toHaveLength(0);
  });

  it("persists the app-default and per-project sessions (v3)", () => {
    const path = tempPath();
    const store = new BotStore(path);
    expect(store.getDefaultBot()).toEqual({ name: "Assistant" });
    expect(store.setDefaultBot({ name: "Helper", persona: "Be kind." }).name).toBe("Helper");
    expect(() => store.setDefaultBot({ name: "  " })).toThrow();
    const created = store.create({ name: "Reviewer" });
    store.setProjectSession(created.id, "abc123", "/s/proj.jsonl");
    expect(store.findByProjectSessionFile("/s/proj.jsonl"))?.toEqual(
      expect.objectContaining({ projectHash: "abc123" })
    );
    expect(store.findByProjectSessionFile("/s/nope.jsonl")).toBeUndefined();
    const reopened = new BotStore(path);
    expect(reopened.getDefaultBot()).toEqual({ name: "Helper", persona: "Be kind." });
    expect(reopened.get(created.id)?.sessionsByProject).toEqual({ abc123: "/s/proj.jsonl" });
    const fs = require("node:fs");
    expect(JSON.parse(fs.readFileSync(path, "utf8")).version).toBe(3);
  });

  it("migrates v1 files (bots without groups)", () => {
    const path = tempPath();
    const store = new BotStore(path);
    store.create({ name: "Reviewer" });
    // Rewrite as a v1 payload and reopen.
    const fs = require("node:fs");
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    fs.writeFileSync(path, JSON.stringify({ version: 1, bots: raw.bots }), "utf8");
    const reopened = new BotStore(path);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.listGroups()).toHaveLength(0);
  });
});
