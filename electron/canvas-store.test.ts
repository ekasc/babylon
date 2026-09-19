import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canvasDir,
  canvasFileName,
  canvasName,
  canvasPath,
  listScenes,
  readScene,
  scenesSignature,
  writeScene,
} from "./canvas-store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "canvas-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("canvas store", () => {
  it("keeps scenes under .pi/canvas in the project", () => {
    expect(canvasDir("/work/project")).toBe("/work/project/.pi/canvas");
    expect(canvasPath("/work/project", "plan")).toBe("/work/project/.pi/canvas/plan.canvas");
  });

  it("does not double up the extension", () => {
    expect(canvasFileName("plan.canvas")).toBe("plan.canvas");
    expect(canvasFileName("plan")).toBe("plan.canvas");
    expect(canvasName("plan.canvas")).toBe("plan");
    expect(canvasName("plan")).toBe("plan");
  });

  it("refuses a name that could leave the project or hide the file", () => {
    for (const name of ["../escape", "a/b", "a\\b", "/etc/passwd", ".hidden", "..dots", ""]) {
      expect(() => canvasPath("/work/project", name)).toThrow(/Invalid canvas name/);
    }
  });

  it("accepts names that stay inside and stay visible", () => {
    for (const name of ["plan", "plan-2", "plan.v2", "Plan_3", "flow.2026-01"]) {
      expect(canvasPath("/work/project", name).startsWith("/work/project/.pi/canvas/")).toBe(true);
    }
  });

  it("lists nothing when the project has no scenes yet", async () => {
    expect(await listScenes(root)).toEqual([]);
  });

  it("round trips a scene and creates the directory on the way", async () => {
    const path = canvasPath(root, "plan");
    await writeScene(path, "canvas 1\n");
    expect(await readScene(path)).toBe("canvas 1\n");
    expect(canvasDir(root)).toMatch(/\.pi\/canvas$/);
  });

  it("reports a missing scene as null rather than throwing", async () => {
    expect(await readScene(canvasPath(root, "absent"))).toBeNull();
  });

  it("lists only scenes, sorted by name", async () => {
    const dir = canvasDir(root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "b.canvas"), "canvas 1\n");
    await writeFile(join(dir, "a.canvas"), "canvas 1\n");
    await writeFile(join(dir, "notes.txt"), "not a scene");
    await mkdir(join(dir, "nested.canvas"));

    const scenes = await listScenes(root);
    expect(scenes.map((scene) => scene.name)).toEqual(["a", "b"]);
    expect(scenes[0].path).toBe(join(dir, "a.canvas"));
    expect(scenes[0].size).toBeGreaterThan(0);
  });

  it("writes a scene the parser accepts", async () => {
    const { parseCanvas } = await import("../src/lib/canvas-dsl");
    const path = canvasPath(root, "roundtrip");
    await writeScene(path, 'canvas 1\n\nnode a process "A"\n');
    const parsed = parseCanvas((await readScene(path))!);
    expect(parsed.ok).toBe(true);
  });
});

describe("scene list signature", () => {
  it("is stable for the same scenes and changes when one is added", async () => {
    const dir = canvasDir(root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.canvas"), "canvas 1\n");
    const before = scenesSignature(await listScenes(root));

    await writeFile(join(dir, "b.canvas"), "canvas 1\n");
    const after = scenesSignature(await listScenes(root));

    expect(after).not.toBe(before);
    expect(scenesSignature(await listScenes(root))).toBe(after);
  });

  it("ignores a file that is not a scene", async () => {
    const dir = canvasDir(root);
    await mkdir(dir, { recursive: true });
    const before = scenesSignature(await listScenes(root));
    await writeFile(join(dir, "notes.txt"), "hello");
    expect(scenesSignature(await listScenes(root))).toBe(before);
  });
});
