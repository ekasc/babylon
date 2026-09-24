import { describe, expect, it } from "vitest";
import { buildContextMenuTemplate } from "./context-menu";

function params(overrides: Record<string, unknown> = {}) {
  return {
    isEditable: false,
    selectionText: "",
    editFlags: { canCut: false, canCopy: false, canPaste: false },
    ...overrides,
  } as Parameters<typeof buildContextMenuTemplate>[0];
}

describe("buildContextMenuTemplate", () => {
  it("offers the standard edit set in editable text", () => {
    const items = buildContextMenuTemplate(
      params({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: false } }),
      true
    );
    expect(items.map((item) => item.role ?? item.type)).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
    expect(items[0]).toMatchObject({ enabled: true });
    expect(items[2]).toMatchObject({ enabled: false });
  });

  it("offers copy for a selection elsewhere", () => {
    expect(buildContextMenuTemplate(params({ selectionText: "some transcript" }), true)).toEqual([
      { role: "copy" },
    ]);
  });

  it("stays quiet on empty chrome", () => {
    expect(buildContextMenuTemplate(params(), true)).toEqual([]);
    expect(buildContextMenuTemplate(params({ selectionText: "   " }), true)).toEqual([]);
  });

  it("appends inspect element in dev builds only", () => {
    let inspected: [number, number] | null = null;
    const dev = buildContextMenuTemplate(params({ selectionText: "x", x: 10, y: 20 }), false, {
      inspectAt: (x, y) => {
        inspected = [x, y];
      },
    });
    expect(dev.at(-2)).toEqual({ type: "separator" });
    const inspect = dev.at(-1);
    expect(inspect).toMatchObject({ label: "Inspect Element" });
    (inspect?.click as (() => void) | undefined)?.();
    expect(inspected).toEqual([10, 20]);
    const prod = buildContextMenuTemplate(params({ selectionText: "x" }), true);
    expect(prod).toEqual([{ role: "copy" }]);
  });
});
