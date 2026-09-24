// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { clearStorageCache, setWithFallback } from "./storage";
import { defineStore, readStore, useVersionedState, writeStore } from "./versioned-store";
import { tabsStore } from "./nav-model";

const stringArray = defineStore<string[]>({
  key: "test-list",
  version: 1,
  fallback: () => [],
  validate: (v): v is string[] => Array.isArray(v) && v.every((e) => typeof e === "string"),
});

beforeEach(() => {
  localStorage.clear();
  clearStorageCache();
});

describe("versioned persisted state", () => {
  it("round-trips stamped payloads", () => {
    writeStore(stringArray, ["a", "b"]);
    expect(readStore(stringArray)).toEqual(["a", "b"]);
  });

  it("falls back on corrupt JSON instead of throwing on a render path", () => {
    setWithFallback("test-list", "{nope");
    expect(readStore(stringArray)).toEqual([]);
  });

  it("falls back on wrong shapes", () => {
    setWithFallback("test-list", JSON.stringify({ version: 1, value: { nope: true } }));
    expect(readStore(stringArray)).toEqual([]);
    setWithFallback("test-list", JSON.stringify([1, 2]));
    expect(readStore(stringArray)).toEqual([]);
  });

  it("migrates legacy unstamped payloads and stamps them", () => {
    const upper = defineStore<string[]>({
      ...stringArray,
      key: "test-migrate",
      version: 2,
      migrate: (v) => (Array.isArray(v) ? v : []).map((s) => String(s).toUpperCase()),
    });
    setWithFallback("test-migrate", JSON.stringify(["a"]));
    expect(readStore(upper)).toEqual(["A"]);
    // Second read loads the stamped v2 directly.
    expect(readStore(upper)).toEqual(["A"]);
  });

  it("loads newer-than-code payloads as-is when valid (no downgrade wipe)", () => {
    setWithFallback("test-list", JSON.stringify({ version: 99, value: ["kept"] }));
    expect(readStore(stringArray)).toEqual(["kept"]);
  });

  it("never migrates or restamps newer-than-code payloads, even with a migrator", () => {
    const upper = defineStore<string[]>({
      ...stringArray,
      key: "test-downgrade",
      version: 2,
      migrate: (v) => (Array.isArray(v) ? v : []).map((s) => String(s).toUpperCase()),
    });
    setWithFallback("test-downgrade", JSON.stringify({ version: 99, value: ["kept"] }));
    expect(readStore(upper)).toEqual(["kept"]);
    // Untouched on disk: still stamped v99, not rewritten as v2.
    expect(JSON.parse(localStorage.getItem("babylon:test-downgrade") ?? "")).toEqual({ version: 99, value: ["kept"] });
  });

  it("migrates stamped older payloads whose shape the validator rejects", () => {
    // Real case: tabs v1 per-space records stamped v1 must reach the v2
    // migrator instead of falling back (which would wipe the tab strip).
    setWithFallback("tabs", JSON.stringify({ version: 1, value: { "/a": ["p1"] } }));
    expect(readStore(tabsStore)).toEqual({ tabs: [{ path: "p1", cwd: "/a" }], activeBySpace: {} });
    // Migrated and restamped as current.
    expect(readStore(tabsStore)).toEqual({ tabs: [{ path: "p1", cwd: "/a" }], activeBySpace: {} });
  });

  it("exposes a hook that persists on change", () => {
    const { result } = renderHook(() => useVersionedState(stringArray));
    expect(result.current[0]).toEqual([]);
    act(() => {
      result.current[1](["x"]);
    });
    expect(result.current[0]).toEqual(["x"]);
    expect(readStore(stringArray)).toEqual(["x"]);
  });
});
