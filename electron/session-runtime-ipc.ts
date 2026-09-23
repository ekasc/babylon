import type { IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import { validateSessionPath } from "./session-path";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { PromptImage } from "../src/bridge";
import { wireOf, wireStr } from "../src/store";
import type { DaemonClient } from "../src/daemon-client";
import type { PiHost } from "./pi-host";
import { loadSessionGoal } from "./goal-mode/store";
import { loadDesignState, stageOfState, unwrapDesignResult } from "./design-mode/store";
import { unwrapDurableGoalResult } from "../src/lib/durable-goal";

type Handle = IpcHandle;

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
  handle("pideck:prompt", async (_e, message: string, images?: unknown[], streamingBehavior?: string) => {
    if (typeof message !== "string" || message.length > 2_000_000) throw new Error("invalid prompt payload");
    if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
      throw new Error("invalid streaming behavior");
    }
    let cleanImages: PromptImage[] | undefined;
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length > 20) throw new Error("invalid image payload");
      cleanImages = images.map((entry) => {
        const img = wireOf(entry);
        const data = wireStr(img, "data");
        if (img?.type !== "image" || data === undefined || data.length > 15_000_000) {
          throw new Error("invalid image payload");
        }
        const mimeType = wireStr(img, "mimeType");
        if (mimeType === undefined || !mimeType.startsWith("image/")) {
          throw new Error("invalid image MIME type");
        }
        return { data, mimeType };
      });
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.prompt", { message, images: cleanImages, streamingBehavior });
      return res.payload;
    }
    const result = await getRuntime().prompt(message, cleanImages, streamingBehavior);
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
  handle("pideck:goal-get", async (_e, sessionId: string, cwd: string) => {
    // The state file is the shared source of truth on this machine: the
    // daemon (or the in-process host) writes it, main reads it straight
    // off disk in both modes. No socket round trip, no staleness window.
    if (typeof sessionId !== "string" || typeof cwd !== "string") throw new Error("invalid goal request");
    return { goal: await loadSessionGoal(cwd, sessionId) };
  });
  handle("pideck:goal-control", async (_e, args: string) => {
    if (typeof args !== "string" || args.length > 5000) throw new Error("invalid goal control");
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.goalControl", { args });
      return { goal: unwrapDurableGoalResult(res.payload, "pi.goalControl") };
    }
    return { goal: await getRuntime().goalControl(args) };
  });
  handle("pideck:design-get", async (_e, sessionId: string, cwd: string) => {
    // Same contract as pideck:goal-get: the state file is the shared
    // source of truth, read straight off disk in both modes.
    if (typeof sessionId !== "string" || typeof cwd !== "string") throw new Error("invalid design request");
    const design = await loadDesignState(cwd, sessionId);
    return { design, stage: stageOfState(cwd, design) };
  });
  handle("pideck:design-control", async (_e, args: string) => {
    if (typeof args !== "string" || args.length > 5000) throw new Error("invalid design control");
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.designControl", { args });
      return unwrapDesignResult(res.payload, "pi.designControl");
    }
    return getRuntime().designControl(args);
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
    return getRuntime().getStats();
  });
}
