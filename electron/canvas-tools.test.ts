import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCanvasTools } from "./canvas-tools";
import { canvasPath, readScene, writeScene } from "./canvas-store";

let root: string;
let check: ReturnType<typeof createCanvasTools>[0];
let write: ReturnType<typeof createCanvasTools>[1];

const clean = `canvas 1\ndirection TB\nnode a process "A"\nnode b process "B"\nedge a -> b "go"`;
const overlapping = `canvas 1\ndirection TB\nnode a process "A" at 0,0\nnode b process "B" at 10,10`;
const invalid = `canvas 1\nnode a widget "A"`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-tools-"));
  [check, write] = createCanvasTools();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type LooseTool = { execute: (...args: any[]) => Promise<unknown> };

function run(tool: LooseTool, params: unknown): Promise<unknown> {
  return tool.execute("test-call", params, undefined, undefined, {} as any);
}

function textOf(result: unknown): string {
  const details = (result as any)?.details;
  return typeof details?.text === "string" ? details.text : "";
}

describe("canvas_check", () => {
  it("checks draft text with no files involved", async () => {
    expect(textOf(await run(check, { text: overlapping }))).toContain("overlap: a b");
    expect(textOf(await run(check, { text: clean }))).toContain("clean:");
    expect(textOf(await run(check, { text: invalid }))).toMatch(/^canvas_check: invalid/);
  });

  it("checks a saved scene by reference", async () => {
    await writeScene(canvasPath(root, "plan"), overlapping);
    expect(textOf(await run(check, { cwd: root, name: "plan" }))).toContain("overlap: a b");
  });

  it("fails closed on missing input and missing scenes", async () => {
    await expect(run(check, {})).rejects.toThrow("canvas_check");
    await expect(run(check, { cwd: root, name: "ghost" })).rejects.toThrow("no scene");
  });
});

describe("canvas_write", () => {
  it("refuses an invalid scene and writes nothing", async () => {
    const out = textOf(await run(write, { cwd: root, name: "bad", text: invalid }));
    expect(out).toMatch(/^not written/);
    expect(await readScene(canvasPath(root, "bad"))).toBeNull();
  });

  it("writes a clean scene and says so", async () => {
    const out = textOf(await run(write, { cwd: root, name: "plan", text: clean }));
    expect(out).toContain("wrote plan (2 nodes, 1 edges)");
    expect(out).toContain("clean");
    expect(await readScene(canvasPath(root, "plan"))).toBe(clean);
  });

  it("writes past warnings but reports them", async () => {
    const out = textOf(await run(write, { cwd: root, name: "messy", text: overlapping }));
    expect(out).toContain("wrote messy");
    expect(out).toContain("overlap: a b");
    expect(await readScene(canvasPath(root, "messy"))).toBe(overlapping);
  });

  it("rejects traversal names before touching the filesystem", async () => {
    await expect(run(write, { cwd: root, name: "../escape", text: clean })).rejects.toThrow();
  });
});
