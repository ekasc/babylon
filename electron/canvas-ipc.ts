// Canvas IPC. One scene is watched at a time, because the canvas shows one file.
// The file is the whole protocol: the agent writes it with its own tools, and the
// watcher turns that into a renderer reload. Nothing here understands the DSL.

import { watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import type { RegionReading } from "../src/lib/sketch-compile";
import type { AgentAction } from "./permissions";
import {
  canvasName,
  canvasPath,
  ensureCanvasDir,
  listScenes,
  readScene,
  scenesSignature,
  writeScene,
} from "./canvas-store";

type Handle = IpcHandle;

export type SketchCrop = { regionId: string; dataUrl: string };

export function registerCanvasIpc(
  handle: Handle,
  deps: {
    getWindow: () => BrowserWindow | null;
    classifyRegions: (cwd: string, crops: SketchCrop[]) => Promise<Record<string, RegionReading>>;
    requestEgressApproval: (action: AgentAction) => Promise<boolean>;
  }
): void {
  let watched: { path: string; dir: string; cwd: string; watcher: FSWatcher; signature: string } | null = null;
  // The renderer writes human edits to this file, so its own write comes straight
  // back through the watcher. Remembering the last write is what stops an echo
  // from reloading the scene out from under an edit that is still in progress.
  let lastWritten: string | null = null;

  const stopWatching = (): void => {
    watched?.watcher.close();
    watched = null;
  };

  const announce = async (path: string, dir: string): Promise<void> => {
    if (watched?.path !== path || watched.dir !== dir) return;
    const current = watched;
    const text = await readScene(path);
    if (text === null || text !== lastWritten) {
      deps
        .getWindow()
        ?.webContents.send("pideck:canvas-changed", { path, name: canvasName(basename(path)), text });
    }
    // A scene the agent wrote appears in the directory without the open file
    // changing, and the picker has to learn about it.
    const scenes = await listScenes(current.cwd);
    const signature = scenesSignature(scenes);
    if (signature === current.signature) return;
    current.signature = signature;
    deps.getWindow()?.webContents.send("pideck:canvas-scenes", scenes);
  };

  handle("pideck:canvas-list", async (_event, cwd: string) => listScenes(cwd));

  handle("pideck:canvas-write", async (_event, cwd: string, name: string, text: string) => {
    const path = canvasPath(cwd, name);
    lastWritten = text;
    await writeScene(path, text);
    return { path };
  });

  handle("pideck:canvas-watch", async (_event, cwd: string | null, name: string | null) => {
    stopWatching();
    if (!cwd || !name) return { text: null };
    const path = canvasPath(cwd, name);
    lastWritten = null;
    // The directory may not exist yet, and watching a path that does not exist
    // throws. Opening the canvas is what creates it.
    const dir = await ensureCanvasDir(cwd);
    // Watch the directory rather than the file. Editors and agent tooling replace
    // files by rename, which leaves a watcher on the old inode with nothing to say.
    const watcher = watch(dir, { persistent: false }, () => {
      void announce(path, dir);
    });
    watched = { path, dir, cwd, watcher, signature: scenesSignature(await listScenes(cwd)) };
    return { path, name: canvasName(name), text: await readScene(path) };
  });

  // Crops are rasterized in the renderer, which is where the canvas is, and read
  // here, which is where the model is. Reading a sketch sends the user's drawing
  // to a model provider, so it goes through the permission gate first, and the
  // action carries the scene path: an approval then means "allow reading this
  // sketch" rather than "allow network access from now on".
  handle("pideck:canvas-classify", async (_event, cwd: string, name: string, crops: SketchCrop[]) => {
    const approved = await deps.requestEgressApproval({
      category: "network_access",
      paths: [canvasPath(cwd, name)],
      description: `Send ${crops.length} hand-drawn shape${crops.length === 1 ? "" : "s"} to the image model to read this sketch`,
    });
    if (!approved) throw new Error("Sending the sketch to the image model was not approved.");
    return deps.classifyRegions(cwd, crops);
  });

  handle("pideck:canvas-unwatch", async () => {
    stopWatching();
    return { ok: true };
  });
}
