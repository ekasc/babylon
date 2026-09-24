import { describe, expect, it } from "vitest";
import { getTerminalLabel, nextTerminalId, resolveTerminalSessionLabel } from "./terminalLabels";

describe("terminalLabels", () => {
  it("formats term-N", () => {
    expect(getTerminalLabel("term-3")).toBe("Terminal 3");
    expect(getTerminalLabel("terminal-2")).toBe("Terminal 2");
    expect(getTerminalLabel("my-term")).toBe("my-term");
  });
  it("prefers summary label", () => {
    expect(resolveTerminalSessionLabel("term-1", { label: "  custom  " })).toBe("custom");
    expect(resolveTerminalSessionLabel("term-1", null)).toBe("Terminal 1");
  });
  it("allocates next id", () => {
    expect(nextTerminalId(["term-1", "term-3"])).toBe("term-2");
    expect(nextTerminalId([])).toBe("term-1");
    expect(nextTerminalId(["", " "])).toBe("term-1");
  });
});
