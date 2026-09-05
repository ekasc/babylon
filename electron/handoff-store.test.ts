import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HandoffStore } from "./handoff-store";

describe("handoff store", () => {
  let dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  async function dir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "babylon-handoffs-"));
    dirs.push(d);
    return d;
  }

  it("appends, lists per source, and records consumption", async () => {
    const store = new HandoffStore(await dir());
    expect(await store.forSource("/s/a.jsonl")).toEqual([]);
    const h = await store.append("/s/a.jsonl", { summary: "## Goal\nx", author: "Helper", sourceChars: 100 });
    expect(h.id).toBeTruthy();
    expect((await store.forSource("/s/a.jsonl")).map((x) => x.id)).toEqual([h.id]);
    expect(await store.forSource("/s/b.jsonl")).toEqual([]);
    expect((await store.findById(h.id))?.summary).toBe("## Goal\nx");
    const marked = await store.markConsumed(h.id, "/s/live.jsonl");
    expect(marked?.consumedInto).toHaveLength(1);
    expect((await store.findById("missing"))).toBeUndefined();
    expect(await store.markConsumed("missing", "/s/live.jsonl")).toBeUndefined();
  });
});
