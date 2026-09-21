import type { IpcMainInvokeEvent } from "electron";

/**
 * Typed wrapper for ipcMain.handle, shared by every *-ipc module.
 * Listeners declare their own argument shapes; the rest array bridges
 * Electron's untyped invoke payload (same-machine renderer, validated
 * per-channel by each handler).
 */
export type IpcHandle = <A extends unknown[]>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: A) => unknown
) => void;
