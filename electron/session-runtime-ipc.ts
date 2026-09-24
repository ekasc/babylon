import type { IpcMainInvokeEvent } from "electron";
import type { IpcHandle } from "./ipc-handle";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contained, validateSessionPath } from "./session-path";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { PromptImage } from "../src/bridge";
import { wireOf, wireStr } from "../src/store";
import type { DaemonClient } from "../src/daemon-client";
import type { PiHost } from "./pi-host";
import { loadSessionGoal } from "./goal-mode/store";
import { designDir, loadDesignState, stageOfState, unwrapDesignBeginResult, unwrapDesignResult } from "./design-mode/store";
import { unwrapDurableGoalResult, unwrapGoalBeginResult } from "../src/lib/durable-goal";
import { unwrapExecutionActivateResult, unwrapExecutionDeactivateResult, unwrapExecutionListResult } from "../src/execution";

type Handle = IpcHandle;

export function registerSessionRuntimeIpc(
  handle: Handle,
  deps: {
    sessionsRoot: string;
    getRuntime: () => RuntimeFacade;
    getHost: () => PiHost;
    isDaemonOwned: () => boolean;
    requireDaemonClient: () => DaemonClient;
    driveSharedChatExtras: (sessionFile: string, userText: string) => Promise<void>;
    applyProjectFocus: (cwd: string) => void;
    clearProjectFocus: () => void;
  },
): void {
  const {
    sessionsRoot,
    getRuntime,
    getHost,
    isDaemonOwned,
    requireDaemonClient,
    driveSharedChatExtras,
    applyProjectFocus,
    clearProjectFocus,
  } = deps;
  handle("pideck:prompt", async (_e, message: string, images?: unknown[], streamingBehavior?: string, sessionFile?: string | null) => {
    if (typeof message !== "string" || message.length > 2_000_000) throw new Error("invalid prompt payload");
    if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
      throw new Error("invalid streaming behavior");
    }
    // Mandatory execution identity: a turn never runs on "whatever is current".
    if (typeof sessionFile !== "string" || sessionFile.length < 1 || sessionFile.length > 4096) {
      throw new Error("prompt requires a session file");
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
      const res = await client.request("pi.prompt", { message, images: cleanImages, streamingBehavior, sessionFile });
      return res.payload;
    }
    const result = await getRuntime().prompt(message, cleanImages, streamingBehavior, sessionFile);
    // Shared project chats: after the default bot's turn settles, staffed
    // extras speak when asked (or freely when the project opted in). Never on
    // mid-stream steer/follow-up turns, and never loudly, a skipped driver is
    // the common case and must not fail the send.
    if (!streamingBehavior) {
      await driveSharedChatExtras(sessionFile, message).catch((err) =>
        console.warn("[pideck] shared-chat extras skipped:", err)
      );
    }
    return result;
  });
  handle("pideck:abort", async (_e, opts?: { sessionFile?: string }) => {
    // Mandatory execution identity: null/empty is a protocol error, never a
    // implicit fallback.
    if (!opts || typeof opts.sessionFile !== "string" || opts.sessionFile.length < 1 || opts.sessionFile.length > 4096) {
      throw new Error("sessionFile is required");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.abort", { sessionFile: opts.sessionFile });
      return res.payload;
    }
    return getRuntime().abort(opts.sessionFile);
  });
  handle("pideck:goal-get", async (_e, sessionId: string, cwd: string) => {
    // The state file is the shared source of truth on this machine: the
    // daemon (or the in-process host) writes it, main reads it straight
    // off disk in both modes. No socket round trip, no staleness window.
    if (typeof sessionId !== "string" || typeof cwd !== "string") throw new Error("invalid goal request");
    return { goal: await loadSessionGoal(cwd, sessionId) };
  });
  handle("pideck:goal-control", async (_e, opts: { sessionFile: string; args: string }) => {
    if (!opts || typeof opts.sessionFile !== "string" || typeof opts.args !== "string" || opts.args.length > 5000) {
      throw new Error("invalid goal control");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.goalControl", { sessionFile: opts.sessionFile, args: opts.args });
      return { goal: unwrapDurableGoalResult(res.payload, "pi.goalControl") };
    }
    return { goal: await getRuntime().goalControl(opts.sessionFile, opts.args) };
  });
  handle("pideck:execution-list", async () => {
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.executionList", {});
      return unwrapExecutionListResult(res.payload, "pi.executionList");
    }
    return getRuntime().executionList();
  });
  // Which project the DESKTOP UI is focused on (LSP/activity/git scope). It is
  // never execution ownership and never a task-resume trigger (item 118).
  handle("pideck:project-focus", (_e, cwd: string | null) => {
    if (cwd === null) {
      // No Space selected means no focused project: forget the previous one so
      // LSP/activity display cannot stay pinned to it.
      clearProjectFocus();
      return { focused: false };
    }
    if (typeof cwd !== "string" || cwd.length < 1 || cwd.length > 4096) throw new Error("invalid project focus");
    applyProjectFocus(cwd);
    return { focused: true };
  });
  handle("pideck:execution-activate", async (_e, opts: { cwd: string; sessionFile?: string; systemPrompt?: string | null }) => {
    if (!opts || typeof opts.cwd !== "string" || opts.cwd.length < 1 || opts.cwd.length > 4096) {
      throw new Error("invalid execution activation");
    }
    if (opts.sessionFile !== undefined && typeof opts.sessionFile !== "string") throw new Error("invalid session file");
    // Creation overlay only: bounded, optional, and never a host-global.
    if (opts.systemPrompt != null && (typeof opts.systemPrompt !== "string" || opts.systemPrompt.length > 20_000)) {
      throw new Error("invalid system prompt");
    }
    const systemPrompt = opts.systemPrompt ?? null;
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.executionActivate", { cwd: opts.cwd, sessionFile: opts.sessionFile, systemPrompt });
      return unwrapExecutionActivateResult(res.payload, "pi.executionActivate");
    }
    return getRuntime().executionActivate(opts.cwd, opts.sessionFile, { systemPrompt });
  });
  handle("pideck:relocate-execution", async (_e, opts: { sessionFile: string; fromCwd: string; toCwd: string }) => {
    if (
      !opts ||
      typeof opts.sessionFile !== "string" || opts.sessionFile.length < 1 || opts.sessionFile.length > 4096 ||
      typeof opts.fromCwd !== "string" || opts.fromCwd.length < 1 || opts.fromCwd.length > 4096 ||
      typeof opts.toCwd !== "string" || opts.toCwd.length < 1 || opts.toCwd.length > 4096
    ) {
      throw new Error("invalid execution relocation");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      return (await client.request("pi.relocateExecution", opts)).payload;
    }
    return getRuntime().relocateExecution(opts.sessionFile, opts.fromCwd, opts.toCwd);
  });
  handle("pideck:execution-deactivate", async (_e, opts: { cwd: string; expectedSessionFile: string }) => {
    if (
      !opts ||
      typeof opts.cwd !== "string" ||
      opts.cwd.length < 1 ||
      typeof opts.expectedSessionFile !== "string" ||
      opts.expectedSessionFile.length < 1
    ) {
      throw new Error("invalid execution deactivation");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.executionDeactivate", { cwd: opts.cwd, expectedSessionFile: opts.expectedSessionFile });
      return unwrapExecutionDeactivateResult(res.payload, "pi.executionDeactivate");
    }
    return getRuntime().executionDeactivate(opts.cwd, opts.expectedSessionFile);
  });
  handle(
    "pideck:goal-begin-prompt",
    async (_e, opts: { sessionFile: string; objective: string; message: string; images?: unknown[]; streamingBehavior?: string }) => {
      if (!opts || typeof opts.sessionFile !== "string" || opts.sessionFile.length < 1 || opts.sessionFile.length > 4096) {
        throw new Error("invalid session file");
      }
      if (typeof opts.objective !== "string" || opts.objective.trim().length < 1 || opts.objective.length > 5000) {
        throw new Error("invalid goal objective");
      }
      // Same payload contract as pideck:prompt (this op sends the turn).
      if (typeof opts.message !== "string" || opts.message.length > 2_000_000) throw new Error("invalid prompt payload");
      if (opts.streamingBehavior !== undefined && opts.streamingBehavior !== "steer" && opts.streamingBehavior !== "followUp") {
        throw new Error("invalid streaming behavior");
      }
      let cleanImages: PromptImage[] | undefined;
      if (opts.images !== undefined) {
        if (!Array.isArray(opts.images) || opts.images.length > 20) throw new Error("invalid image payload");
        cleanImages = opts.images.map((entry) => {
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
        const res = await client.request("pi.goalBeginPrompt", {
          sessionFile: opts.sessionFile,
          objective: opts.objective,
          message: opts.message,
          images: cleanImages,
          streamingBehavior: opts.streamingBehavior,
        });
        return unwrapGoalBeginResult(res.payload, "pi.goalBeginPrompt");
      }
      return getRuntime().beginGoalPrompt(opts.sessionFile, opts.objective, opts.message, cleanImages, opts.streamingBehavior);
    }
  );
  handle("pideck:design-get", async (_e, sessionId: string, cwd: string) => {
    // Same contract as pideck:goal-get: the state file is the shared
    // source of truth, read straight off disk in both modes.
    if (typeof sessionId !== "string" || typeof cwd !== "string") throw new Error("invalid design request");
    const design = await loadDesignState(cwd, sessionId);
    return { design, stage: stageOfState(cwd, design) };
  });
  // Review screenshots are written next to the design artifacts and are read
  // back on demand: the transcript keeps only the path, so a session log never
  // carries megabytes of base64. The path is re-validated against the project
  // root here — the renderer is never trusted to have checked it.
  handle("pideck:design-review-shot", async (_e, opts: { cwd: string; path: string }) => {
    if (
      !opts ||
      typeof opts.cwd !== "string" || opts.cwd.length < 1 || opts.cwd.length > 4096 ||
      typeof opts.path !== "string" || opts.path.length < 1 || opts.path.length > 4096
    ) {
      throw new Error("invalid design review shot");
    }
    // Containment: the file must live under <cwd>/.babylon/design/<slug>/reviews.
    const expected = join(designDir(opts.cwd));
    if (!contained(expected, resolve(opts.cwd, opts.path))) {
      throw new Error("design review shot is outside the design directory");
    }
    const bytes = await readFile(resolve(opts.cwd, opts.path));
    return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  });
  handle("pideck:design-control", async (_e, opts: { sessionFile: string; args: string }) => {
    if (!opts || typeof opts.sessionFile !== "string" || typeof opts.args !== "string" || opts.args.length > 5000) {
      throw new Error("invalid design control");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.designControl", { sessionFile: opts.sessionFile, args: opts.args });
      return unwrapDesignResult(res.payload, "pi.designControl");
    }
    return getRuntime().designControl(opts.sessionFile, opts.args);
  });
  handle(
    "pideck:design-begin-prompt",
    async (_e, opts: { sessionFile: string; subject: string; message: string; images?: unknown[]; streamingBehavior?: string }) => {
      if (!opts || typeof opts.sessionFile !== "string" || opts.sessionFile.length < 1 || opts.sessionFile.length > 4096) {
        throw new Error("invalid session file");
      }
      if (typeof opts.subject !== "string" || opts.subject.trim().length < 1 || opts.subject.length > 5000) {
        throw new Error("invalid design subject");
      }
      // Same payload contract as pideck:goal-begin-prompt (this op sends the turn).
      if (typeof opts.message !== "string" || opts.message.length > 2_000_000) throw new Error("invalid prompt payload");
      if (opts.streamingBehavior !== undefined && opts.streamingBehavior !== "steer" && opts.streamingBehavior !== "followUp") {
        throw new Error("invalid streaming behavior");
      }
      let cleanImages: PromptImage[] | undefined;
      if (opts.images !== undefined) {
        if (!Array.isArray(opts.images) || opts.images.length > 20) throw new Error("invalid image payload");
        cleanImages = opts.images.map((entry) => {
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
        const res = await client.request("pi.designBeginPrompt", {
          sessionFile: opts.sessionFile,
          subject: opts.subject,
          message: opts.message,
          images: cleanImages,
          streamingBehavior: opts.streamingBehavior,
        });
        return unwrapDesignBeginResult(res.payload, "pi.designBeginPrompt");
      }
      return getRuntime().beginDesignPrompt(opts.sessionFile, opts.subject, opts.message, cleanImages, opts.streamingBehavior);
    }
  );
  handle("pideck:refresh-session", async (_e, path: string) => {
    const p = await validateSessionPath(sessionsRoot, path);
    // Route through the runtime facade so local and daemon modes behave the
    // same: the daemon returns { refreshed: boolean } via pi.refreshFromDisk,
    // not a raw pi.getState payload.
    return getRuntime().refreshFromDisk(p);
  });
  handle("pideck:get-messages", async (_e, sessionFile: unknown) => {
    if (typeof sessionFile !== "string" || sessionFile.length < 1 || sessionFile.length > 4096) {
      throw new Error("invalid session file");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getMessages", { sessionFile });
      return (res.payload as { messages?: unknown[] }).messages ?? [];
    }
    return getRuntime().getMessages(sessionFile);
  });
  handle("pideck:get-state", async (_e, opts?: { sessionFile?: string }) => {
    const sessionFile = opts?.sessionFile;
    if (typeof sessionFile !== "string" || sessionFile.length < 1 || sessionFile.length > 4096) {
      throw new Error("get-state requires { sessionFile }");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getState", { sessionFile });
      return res.payload;
    }
    return getRuntime().getState(sessionFile);
  });
  handle("pideck:get-stats", async (_e, sessionFile: unknown) => {
    if (typeof sessionFile !== "string" || sessionFile.length < 1 || sessionFile.length > 4096) {
      throw new Error("invalid session file");
    }
    if (isDaemonOwned()) {
      const client = requireDaemonClient();
      const res = await client.request("pi.getStats", { sessionFile });
      return res.payload;
    }
    return getRuntime().getStats(sessionFile);
  });
}
