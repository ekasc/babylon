// Scenes live in the project, under `.pi/canvas`, beside the other per-project
// artifacts. That placement is the whole point of the medium choice: a scene sits
// in the working tree, so the agent reaches it with the file tools it already has
// and the human can commit it next to the code it describes.

import { promises as fsp } from "node:fs";
import { dirname, join, relative } from "node:path";

export const CANVAS_EXT = ".canvas";

export type CanvasSceneFile = { name: string; path: string; mtime: number; size: number };

export function canvasDir(cwd: string): string {
  return join(cwd, ".pi", "canvas");
}

// A name arrives from the renderer, so it may not contain a path separator.
// That single restriction is what keeps the resolved path inside the project.
const CANVAS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function canvasFileName(name: string): string {
  if (!CANVAS_NAME.test(name)) throw new Error(`Invalid canvas name: ${name}`);
  return name.endsWith(CANVAS_EXT) ? name : `${name}${CANVAS_EXT}`;
}

export function canvasPath(cwd: string, name: string): string {
  const dir = canvasDir(cwd);
  const path = join(dir, canvasFileName(name));
  const relativePath = relative(dir, path);
  if (relativePath.startsWith("..")) throw new Error(`Invalid canvas name: ${name}`);
  return path;
}

export function canvasName(fileName: string): string {
  return fileName.endsWith(CANVAS_EXT) ? fileName.slice(0, -CANVAS_EXT.length) : fileName;
}

export async function listScenes(cwd: string): Promise<CanvasSceneFile[]> {
  const dir = canvasDir(cwd);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    // No directory yet is an empty canvas list, not an error.
    return [];
  }
  const scenes: CanvasSceneFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(CANVAS_EXT)) continue;
    const path = join(dir, entry);
    try {
      const stat = await fsp.stat(path);
      if (!stat.isFile()) continue;
      scenes.push({ name: canvasName(entry), path, mtime: stat.mtimeMs, size: stat.size });
    } catch {
      // A file that vanished between readdir and stat is simply not listed.
      continue;
    }
  }
  return scenes.sort((left, right) => left.name.localeCompare(right.name));
}

export async function ensureCanvasDir(cwd: string): Promise<string> {
  const dir = canvasDir(cwd);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Change detector for a scene list: enough to tell "something appeared or moved"
 *  without diffing every entry. */
export function scenesSignature(scenes: CanvasSceneFile[]): string {
  return scenes.map((scene) => `${scene.name}:${scene.mtime}:${scene.size}`).join("|");
}

export async function readScene(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeScene(path: string, text: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(path, text, "utf8");
}
