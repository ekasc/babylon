import type { IpcMainInvokeEvent } from "electron";
import { validateSessionPath } from "./session-path";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { DaemonClient } from "../src/daemon-client";
import type { PiHost } from "./pi-host";

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
) => void;

export function registerSessionRuntimeIpc(
  handle: Handle,
  deps: {
    sessionsRoot: string;
    getRuntime: () => RuntimeFacade;
    getHost: () => PiHost;
    isDaemonOwned: () => boolean;
    requireDaemonClient: () => DaemonClient;
    driveSharedChatExtras: (userText: string) => Promise<void>;
  },
): void {
  const { sessionsRoot, getRuntime, getHost, isDaemonOwned, requireDaemonClient, driveSharedChatExtras } = deps;
  handle("pideck:prompt", async (_e, message: string, images?: any[], streamingBehavior?: string) => {
    if (typeof message !== "string" || message.length > 2_000_000) throw new Error("invalid prompt payload");
    if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
      throw new Error("invalid streaming behavior");
    }
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length > 20) throw new Error("invalid image payload");
      for (const image of images) {
        if (image?.type !== "image" || typeof image.data !== "string" || image.data.length > 15_000_000) {
          throw new Error("invalid image payload");
        }
        if (typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
          throw new Error("invalid image MIME type");
        }
      }
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.prompt", { message, images, streamingBehavior });
      return res.payload;
    }
    const result = await getRuntime().prompt(message, images, streamingBehavior);
    // Shared project chats: after the default bot's turn settles, staffed
    // extras speak when asked (or freely when the project opted in). Never on
    // mid-stream steer/follow-up turns, and never loudly, a skipped driver is
    // the common case and must not fail the send.
    if (!streamingBehavior) {
      await driveSharedChatExtras(message).catch((err) =>
        console.warn("[pideck] shared-chat extras skipped:", err)
      );
    }
    return result;
  });
  handle("pideck:abort", async (_e, opts?: { sessionFile?: string }) => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.abort", {});
      return res.payload;
    }
    return getRuntime().abort(opts?.sessionFile);
  });
  handle("pideck:session:release", async (_e, path: string) => {
    const target = await validateSessionPath(sessionsRoot, path);
    if (isDaemonOwned()) return { released: false };
    const host = getHost();
    return { released: await host.releaseSession(target) };
  });
  handle("pideck:refresh-session", async (_e, path: string) => {
    const p = await validateSessionPath(sessionsRoot, path);
    // Route through the runtime facade so local and daemon modes behave the
    // same: the daemon returns { refreshed: boolean } via pi.refreshFromDisk,
    // not a raw pi.getState payload.
    return getRuntime().refreshFromDisk(p);
  });
  handle("pideck:get-messages", async () => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getMessages", {});
      return (res.payload as { messages?: unknown[] }).messages ?? [];
    }
    return getRuntime().getMessages();
  });
  handle("pideck:get-state", async () => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getState", {});
      return res.payload;
    }
    return getRuntime().getState();
  });
  handle("pideck:get-stats", async () => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getStats", {});
      return res.payload;
    }
    return (getRuntime() as any).getStats?.() ?? (getHost() as any).getStats();
  });
}
