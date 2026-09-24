import { describe, expect, it } from "vitest";
import { checkCanvasText, formatCheckReport } from "./canvas-check";

const head = "canvas 1\ndirection TB";

function scene(...lines: string[]): string {
  return [head, ...lines].join("\n");
}

describe("checkCanvasText", () => {
  it("passes parse errors through with line numbers", () => {
    const report = checkCanvasText(scene(`node a widget "A"`));
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]?.line).toBe(3);
    expect(formatCheckReport(report)).toMatch(/^canvas_check: invalid/);
  });

  it("calls a clean scene clean", () => {
    const report = checkCanvasText(scene(`node a process "A"`, `node b process "B"`, `edge a -> b "go"`));
    expect(report.ok).toBe(true);
    expect(report.overlapCount).toBe(0);
    expect(report.labelCollisionCount).toBe(0);
    expect(report.nodes).toBe(2);
    expect(report.edges).toBe(1);
    expect(formatCheckReport(report)).toContain("clean:");
  });

  it("flags two leaves on top of each other", () => {
    const report = checkCanvasText(scene(`node a process "A" at 0,0`, `node b process "B" at 10,10`));
    expect(report.ok).toBe(true);
    expect(report.overlapCount).toBe(1);
    expect(report.overlaps).toEqual([{ a: "a", b: "b" }]);
    expect(formatCheckReport(report)).toContain("overlap: a b");
  });

  it("does not flag a member inside its own group", () => {
    const report = checkCanvasText(
      scene(`node g group "G"`, `node a process "A" at 0,0 in g`, `node b process "B" at 300,300`)
    );
    expect(report.ok).toBe(true);
    expect(report.overlapCount).toBe(0);
  });

  it("flags two groups covering each other, members included", () => {
    const report = checkCanvasText(
      scene(
        `node g1 group "G1"`,
        `node g2 group "G2"`,
        `node a process "A" at 0,0 in g1`,
        `node b process "B" at 0,0 in g2`
      )
    );
    expect(report.ok).toBe(true);
    // g1/g2, a/b, plus each leaf inside the other group: all real defects.
    expect(report.overlapCount).toBe(4);
    expect(report.overlaps).toContainEqual({ a: "g1", b: "g2" });
    expect(report.overlaps).toContainEqual({ a: "a", b: "b" });
  });

  it("flags an edge label sitting inside another node", () => {
    const report = checkCanvasText(
      scene(`node a process "A" at 0,0`, `node b process "B" at 400,0`, `node c process "C" at 150,0`, `edge a -> b "go"`)
    );
    expect(report.ok).toBe(true);
    expect(report.overlapCount).toBe(0);
    expect(report.labelCollisionCount).toBe(1);
    expect(report.labelCollisions).toEqual([{ edge: "a->b", node: "c" }]);
    expect(formatCheckReport(report)).toContain("label-collision: edge a->b with node c");
  });

  it("caps long finding lists but keeps the totals", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `node n${i} process "N${i}" at 0,0`);
    const report = checkCanvasText(scene(...lines));
    expect(report.ok).toBe(true);
    expect(report.overlapCount).toBe(45);
    expect(report.overlaps.length).toBe(8);
    expect(formatCheckReport(report)).toContain("... and 37 more overlaps");
  });
});
