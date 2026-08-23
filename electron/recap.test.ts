import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecapStore } from "./recap-store";
import {
  buildRecapPrompt,
  mergeRecaps,
  mergeRecapsIntoWindow,
  normalizeRecapText,
  pickRecapDelta,
  recapDue,
  recapWorthy,
  RECAP_INTERVAL_MS,
  type Recap,
} from "./recap";

function entry(id: string, role: string, text: string, ts: string): any {
  return { id, type: "message", timestamp: ts, message: { role, content: text, timestamp: Date.parse(ts) } };
}

describe("mergeRecaps interleaving", () => {
  // Regression: when projected messages lacked timestamps, the merge sorted
  // every recap after every message — a pile of back-to-back "Recap:" lines at
  // the tail instead of one recap per turn.
  it("places each recap right after the exchange it summarizes", () => {
    const messages = [
      { role: "user", content: "turn one", timestamp: Date.parse("2026-01-01T10:00:00Z") },
      { role: "assistant", content: "done", timestamp: Date.parse("2026-01-01T10:01:00Z") },
      { role: "user", content: "turn two", timestamp: Date.parse("2026-01-01T11:00:00Z") },
      { role: "assistant", content: "also done", timestamp: Date.parse("2026-01-01T11:01:00Z") },
    ];
    const recaps: Recap[] = [
      { id: "r1", at: "2026-01-01T10:03:00Z", coveredEntryId: "m2", text: "Recap: one" },
      { id: "r2", at: "2026-01-01T11:03:00Z", coveredEntryId: "m4", text: "Recap: two" },
    ];
    const merged = mergeRecaps(messages, recaps);
    expect(merged.map((m: any) => m.content ?? m.text)).toEqual([
      "turn one",
      "done",
      "Recap: one",
      "turn two",
      "also done",
      "Recap: two",
    ]);
  });
});

describe("recapDue", () => {
  it("is due only after the interval with no recap covering the stretch", () => {
    const now = 1_000_000;
    expect(recapDue(now - RECAP_INTERVAL_MS - 1, null, now)).toBe(true);
    expect(recapDue(now - RECAP_INTERVAL_MS + 1000, null, now)).toBe(false);
    // A recap older than the last message doesn't cover it: due.
    expect(recapDue(now - RECAP_INTERVAL_MS - 1, now - RECAP_INTERVAL_MS - 5000, now)).toBe(true);
    // A recap newer than the last message already covers it: not due.
    expect(recapDue(now - RECAP_INTERVAL_MS - 1, now - 1000, now)).toBe(false);
    expect(recapDue(0, null, now)).toBe(false);
  });
});

describe("pickRecapDelta", () => {
  const msg = (id: string, role: string, text: string) => ({
    id,
    entryId: id,
    role,
    content: text,
    timestamp: Date.parse("2026-01-01T00:00:00Z"),
  });
  const messages = [msg("a", "user", "hello"), msg("b", "assistant", "hi there"), msg("c", "user", "second message"), msg("d", "assistant", "reply two")];

  it("starts from the previous anchor", () => {
    const { messages: delta, coveredEntryId } = pickRecapDelta(messages, "b");
    expect(delta.map((m) => m.entryId)).toEqual(["c", "d"]);
    expect(coveredEntryId).toBe("d");
    expect(delta[0].role).toBe("user");
  });

  it("falls back to the most recent window when the anchor is gone", () => {
    const { messages: delta } = pickRecapDelta(messages, "gone-id", 2);
    expect(delta.map((m) => m.entryId)).toEqual(["c", "d"]);
  });

  it("covers the recent stretch when there is no anchor", () => {
    const { messages: all } = pickRecapDelta(messages, null);
    expect(all).toHaveLength(4);
    const { messages: recent, coveredEntryId } = pickRecapDelta(messages, null, 2);
    expect(recent.map((m) => m.entryId)).toEqual(["c", "d"]);
    expect(coveredEntryId).toBe("d");
  });
});

describe("recapWorthy", () => {
  const msg = (text: string) => ({ role: "user", content: text });

  it("requires a real exchange, not a ping", () => {
    expect(recapWorthy([msg("ping")])).toBe(false);
    expect(recapWorthy([msg("ping"), { role: "assistant", content: "pong" }])).toBe(false);
    expect(recapWorthy([msg("x".repeat(300)), { role: "assistant", content: "y".repeat(200) }])).toBe(true);
  });
});

describe("normalizeRecapText", () => {
  it("always prefixes exactly once", () => {
    expect(normalizeRecapText("Fixed the auth flow and added tests")).toBe("Recap: Fixed the auth flow and added tests");
    expect(normalizeRecapText("Recap: Fixed the auth flow")).toBe("Recap: Fixed the auth flow");
    expect(normalizeRecapText("  recap: fixed it  ")).toBe("Recap: fixed it");
    expect(normalizeRecapText("   ")).toBeNull();
  });
});

describe("buildRecapPrompt", () => {
  it("requests a single Recap line", () => {
    const prompt = buildRecapPrompt("user: hi");
    expect(prompt).toContain("Recap:");
    expect(prompt).toContain("user: hi");
  });
});

const fixtureRecap: Recap = { id: "r1", at: new Date(2000).toISOString(), coveredEntryId: "b", text: "Recap: hi" };

describe("mergeRecaps", () => {
  const message = (ts: number) => ({ role: "user", content: "x", timestamp: ts });
  const rec = (at: number): Recap => ({ id: "r1", at: new Date(at).toISOString(), coveredEntryId: "b", text: "Recap: hi" });

  it("interleaves recaps by timestamp", () => {
    const merged = mergeRecaps([message(1000), message(3000)], [rec(2000)]);
    expect(merged.map((m) => m.entryId ?? null)).toEqual([null, "recap:r1", null]);
    expect(merged[1].customType).toBe("babylon_recap");
    expect(merged[1].content).toBe("Recap: hi");
  });

  it("leaves the window alone when there are no recaps", () => {
    const messages = [message(1000)];
    expect(mergeRecaps(messages, [])).toBe(messages);
  });
});

describe("mergeRecapsIntoWindow", () => {
  const message = (ts: number) => ({ role: "user", content: "x", timestamp: ts });
  const rec = (id: string, at: number): Recap => ({ id, at: new Date(at).toISOString(), coveredEntryId: "b", text: "Recap: hi" });

  it("keeps only recaps generated inside the window's time span", () => {
    // Older transcript window (an earlier scroll-up page) with a recap that was
    // generated while this stretch was the live tail.
    const merged = mergeRecapsIntoWindow([message(1000), message(3000)], [rec("r1", 2000), rec("r2", 9000)]);
    expect(merged.map((m) => (m as any).entryId ?? null)).toEqual([null, "recap:r1", null]);
  });

  it("never duplicates a recap across disjoint windows of one scroll-back", () => {
    const older = [message(1000), message(3000)];
    const newer = [message(5000), message(6000)];
    const recaps = [rec("r1", 2000), rec("r2", 5500)];
    const inOlder = mergeRecapsIntoWindow(older, recaps);
    const inNewer = mergeRecapsIntoWindow(newer, recaps);
    expect(inOlder.filter((m) => m.customType === "babylon_recap")).toHaveLength(1);
    expect(inNewer.filter((m) => m.customType === "babylon_recap")).toHaveLength(1);
    expect((inNewer[1] as any).entryId).toBe("recap:r2");
  });

  it("returns the window untouched when no recap falls inside it", () => {
    const messages = [message(1000), message(3000)];
    expect(mergeRecapsIntoWindow(messages, [rec("r1", 9000)])).toBe(messages);
    expect(mergeRecapsIntoWindow([], [rec("r1", 2000)])).toEqual([]);
  });
});

describe("RecapStore", () => {
  it("persists and loads per-session recaps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babylon-recap-"));
    try {
      const store = new RecapStore(dir);
      expect(await store.recapsFor("/s/a.jsonl")).toEqual([]);
      await store.append("/s/a.jsonl", fixtureRecap);
      await store.append("/s/a.jsonl", { ...fixtureRecap, id: "r2", text: "Recap: more" });
      await store.append("/s/b.jsonl", { ...fixtureRecap, id: "r3" });
      const a = await store.recapsFor("/s/a.jsonl");
      expect(a.map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(await store.recapsFor("/s/b.jsonl")).toHaveLength(1);
      // Reload from disk (fresh store) reflects the same data.
      const fresh = new RecapStore(dir);
      expect((await fresh.recapsFor("/s/a.jsonl")).map((r) => r.id)).toEqual(["r1", "r2"]);
      expect(JSON.parse(await readFile(join(dir, "recaps.json"), "utf8")).version).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
