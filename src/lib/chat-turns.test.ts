import { describe, expect, it } from "vitest";
import {
  TURN_FALLBACK_HEIGHT,
  buildTurnViewModels,
  compensateMeasuredHeight,
  estimateTurnHeight,
  estimateTurnOffset,
  findTurnIndexForItem,
  getMeasuredHeight,
  groupContiguousRuns,
  layoutTurns,
  prependScrollCorrection,
  resolveVisibleTurnRange,
  setMeasuredHeight,
  type TurnEntry,
  type TurnMeasurements,
  type TurnViewModel,
} from "./chat-turns";
import type { TurnFold } from "./chat-folds";
import type { ChatItem } from "../store";

function fold(start: number, end: number, turnId: string): TurnFold {
  return { start, end, turnId, label: "work", hiddenCount: end - start - 2, terminalIdx: end - 1 };
}

function single(index: number, kind: "user" | "assistant" = "assistant"): TurnEntry {
  const item: ChatItem =
    kind === "user"
      ? { kind, key: `k${index}`, text: `t${index}` }
      : { kind, key: `k${index}`, blocks: [{ type: "text", text: `t${index}` }] };
  return { type: "single", item, index };
}

function userIdAt(starts: number[]): (start: number) => string | null {
  return (start) => (starts.includes(start) ? `user-${start}` : null);
}

describe("buildTurnViewModels", () => {
  it("partitions entries into prologue + user turns with fold state", () => {
    const entries: TurnEntry[] = [single(0, "user"), single(1), single(2), single(3, "user"), single(4)];
    const folds = new Map([[0, fold(0, 3, "t0")]]);
    const turns = buildTurnViewModels({
      entries,
      itemCount: 5,
      userIndices: [0, 3],
      userIdAt: userIdAt([0, 3]),
      foldAt: (s) => folds.get(s),
      liveTurnId: null,
      isCollapsed: () => true,
      streaming: false,
    });
    expect(turns.map((t) => ({ id: t.id, start: t.start, end: t.end, collapsed: t.collapsed, live: t.live, n: t.entries.length }))).toEqual([
      { id: "t0", start: 0, end: 3, collapsed: true, live: false, n: 3 },
      { id: "user-3", start: 3, end: 5, collapsed: false, live: false, n: 2 },
    ]);
  });

  it("keeps a leading prologue turn and marks the streaming tail live", () => {
    const entries: TurnEntry[] = [single(0), single(1), single(2, "user"), single(3)];
    const turns = buildTurnViewModels({
      entries,
      itemCount: 4,
      userIndices: [2],
      userIdAt: userIdAt([2]),
      foldAt: () => undefined,
      liveTurnId: null,
      isCollapsed: () => false,
      streaming: true,
    });
    expect(turns.map((t) => t.id)).toEqual(["__prologue", "user-2"]);
    expect(turns[0]).toMatchObject({ start: 0, end: 2, collapsed: false, live: false });
    expect(turns[1]).toMatchObject({ start: 2, end: 4, live: true });
  });

  it("forces the live fold id live even when it is not the tail", () => {
    const entries: TurnEntry[] = [single(0, "user"), single(1)];
    const folds = new Map([[0, fold(0, 2, "t0")]]);
    const turns = buildTurnViewModels({
      entries,
      itemCount: 2,
      userIndices: [0],
      userIdAt: userIdAt([0]),
      foldAt: (s) => folds.get(s),
      liveTurnId: "t0",
      isCollapsed: () => false,
      streaming: true,
    });
    expect(turns[0]).toMatchObject({ id: "t0", live: true, collapsed: false });
  });
});

describe("resolveVisibleTurnRange", () => {
  const heights = [100, 200, 150, 300, 120];
  const { offsets } = layoutTurns(heights, TURN_FALLBACK_HEIGHT);

  it("covers the viewport plus overscan on both sides", () => {
    // Viewport 200..400: turns 1 (100..300) and 2 (300..450) visible.
    const win = resolveVisibleTurnRange({
      turnCount: 5,
      scrollTop: 200,
      viewportHeight: 200,
      offsets,
      heights,
      overscanTurns: 1,
    });
    expect(win).toEqual({ start: 0, end: 4, extra: [] });
  });

  it("clamps at the list edges", () => {
    const top = resolveVisibleTurnRange({ turnCount: 5, scrollTop: 0, viewportHeight: 50, offsets, heights, overscanTurns: 4 });
    expect(top).toEqual({ start: 0, end: 5, extra: [] });
    const bottom = resolveVisibleTurnRange({ turnCount: 5, scrollTop: 10000, viewportHeight: 800, offsets, heights, overscanTurns: 4 });
    expect(bottom.start).toBe(0);
    expect(bottom.end).toBe(5);
  });

  it("forces pinned turns outside the band in as islands", () => {
    const win = resolveVisibleTurnRange({
      turnCount: 5,
      scrollTop: 0,
      viewportHeight: 50,
      offsets,
      heights,
      overscanTurns: 0,
      pinned: [4],
    });
    expect(win.start).toBe(0);
    expect(win.end).toBe(1);
    expect(win.extra).toEqual([4]);
  });

  it("ignores out-of-range and duplicate pins", () => {
    const win = resolveVisibleTurnRange({
      turnCount: 3,
      scrollTop: 0,
      viewportHeight: 1000,
      offsets: layoutTurns([100, 100, 100], TURN_FALLBACK_HEIGHT).offsets,
      heights: [100, 100, 100],
      overscanTurns: 0,
      pinned: [-1, 1, 1, 99],
    });
    expect(win.extra).toEqual([]);
  });

  it("returns empty for no turns", () => {
    expect(
      resolveVisibleTurnRange({ turnCount: 0, scrollTop: 0, viewportHeight: 800, offsets: [], heights: [] })
    ).toEqual({ start: 0, end: 0, extra: [] });
  });
});

describe("groupContiguousRuns", () => {
  it("groups a band plus islands", () => {
    expect(groupContiguousRuns([0, 1, 2, 4, 7, 8])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 5 },
      { start: 7, end: 9 },
    ]);
  });

  it("dedupes and sorts", () => {
    expect(groupContiguousRuns([3, 1, 3, 2])).toEqual([{ start: 1, end: 4 }]);
  });
});

describe("layoutTurns + estimateTurnOffset", () => {
  it("prefix-sums with fallback for unmeasured turns", () => {
    const { offsets, total } = layoutTurns([100, undefined, 50], 320);
    expect(offsets).toEqual([0, 100, 420]);
    expect(total).toBe(470);
    expect(estimateTurnOffset(2, [100, undefined, 50], 320)).toBe(420);
  });
});

describe("compensateMeasuredHeight", () => {
  it("shifts the anchor when a turn above shrinks or grows", () => {
    expect(compensateMeasuredHeight({ scrollTop: 1000, turnOffsetTop: 400, oldHeight: 300, newHeight: 200 })).toBe(900);
    expect(compensateMeasuredHeight({ scrollTop: 1000, turnOffsetTop: 400, oldHeight: 300, newHeight: 500 })).toBe(1200);
  });

  it("leaves scrollTop alone when the turn is at or below the viewport top", () => {
    expect(compensateMeasuredHeight({ scrollTop: 500, turnOffsetTop: 400, oldHeight: 300, newHeight: 200 })).toBe(500);
    expect(compensateMeasuredHeight({ scrollTop: 500, turnOffsetTop: 900, oldHeight: 100, newHeight: 400 })).toBe(500);
  });

  it("floors at zero on full collapse above the viewport", () => {
    // turnOffsetTop >= 0 implies result >= 0 always; this pins the boundary.
    expect(compensateMeasuredHeight({ scrollTop: 5, turnOffsetTop: 0, oldHeight: 5, newHeight: 0 })).toBe(0);
  });
});

describe("prependScrollCorrection", () => {
  it("adds exactly the height that arrived above the anchor", () => {
    expect(prependScrollCorrection({ prevScrollTop: 120, prevAnchorOffsetTop: 1000, nextAnchorOffsetTop: 1600 })).toBe(720);
  });

  it("clamps at zero", () => {
    expect(prependScrollCorrection({ prevScrollTop: 0, prevAnchorOffsetTop: 500, nextAnchorOffsetTop: 100 })).toBe(0);
  });
});

describe("findTurnIndexForItem", () => {
  const turns = [
    { id: "p", start: 0, end: 2 },
    { id: "a", start: 2, end: 9 },
    { id: "b", start: 9, end: 20 },
  ] as TurnViewModel[];

  it("locates the owning turn and clamps out-of-range input", () => {
    expect(findTurnIndexForItem(turns, 0)).toBe(0);
    expect(findTurnIndexForItem(turns, 5)).toBe(1);
    expect(findTurnIndexForItem(turns, 19)).toBe(2);
    expect(findTurnIndexForItem(turns, 99)).toBe(2);
    expect(findTurnIndexForItem([], 5)).toBe(-1);
  });
});

describe("measurement cache", () => {
  it("isolates sessions and prunes oldest beyond the cap", () => {
    const cache: TurnMeasurements = new Map();
    setMeasuredHeight(cache, "s1", "t1", 100);
    setMeasuredHeight(cache, null, "t1", 999);
    expect(getMeasuredHeight(cache, "s1", "t1")).toBe(100);
    expect(getMeasuredHeight(cache, "s2", "t1")).toBeUndefined();
    expect(getMeasuredHeight(cache, null, "t1")).toBeUndefined();
    for (let i = 0; i < 15; i++) setMeasuredHeight(cache, `s${i}`, "t", 10, 12);
    expect(cache.size).toBe(12);
    expect(cache.has("s0")).toBe(false);
    expect(cache.has("s14")).toBe(true);
  });

  it("estimates from the session mean, else the fallback", () => {
    const cache: TurnMeasurements = new Map();
    expect(estimateTurnHeight(cache, "s1", 320)).toBe(320);
    setMeasuredHeight(cache, "s1", "a", 100);
    setMeasuredHeight(cache, "s1", "b", 300);
    expect(estimateTurnHeight(cache, "s1", 320)).toBe(200);
    expect(estimateTurnHeight(cache, "other", 320)).toBe(320);
  });
});
