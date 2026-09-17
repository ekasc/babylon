import type { IpcMainInvokeEvent } from "electron";
import { app } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import { projectHashForCwd, type ProjectSettingsStore } from "./project-settings";
import { HandoffStore } from "./handoff-store";
import { driveRoomTurns } from "./room-driver";
import { readSessionTail, type SessionIndex } from "./sessions";
import { buildHandoffPrompt, normalizeHandoffText, transcriptText } from "./recap";
import { validateSessionPath } from "./session-path";
import { botChatForProject, botHandle, buildBotSystemPrompt, buildGroupSystemPrompt, groupAnchorCwd, isPassReply, parseBotMentions } from "../src/bots";
import type { BotStore } from "./bots";
import type { TaskManager } from "./task-manager";
import type { RuntimeFacade } from "../src/runtime-facade";
import type { PiHost } from "./pi-host";

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
) => void;

export function registerBotsIpc(
  handle: Handle,
  deps: {
    sessionsRoot: string;
    botStore: BotStore;
    projectSettings: ProjectSettingsStore;
    sessionIndex: SessionIndex;
    taskManager: TaskManager;
    getRuntime: () => RuntimeFacade;
    getHost: () => PiHost;
    isDaemonOwned: () => boolean;
    getHostReady: () => Promise<void> | null;
    getActiveCwd: () => string;
    broadcastBots: () => void;
    broadcastGroups: () => void;
    projectSettingsForCwd: (cwd: string) => { settings: any; hash: string };
    resolveCanonicalSessionFile: (stored: string | null | undefined) => Promise<string | undefined>;
    overlayForSessionFile: (file: string | null | undefined, cwd?: string) => string | null;
    driveExtrasIO: () => any;
    lastAssistantText: (messages: any[]) => string;
  },
): void {
  const {
    sessionsRoot,
    botStore,
    projectSettings,
    sessionIndex,
    taskManager,
    getRuntime,
    getHost,
    isDaemonOwned,
    getHostReady,
    getActiveCwd,
    broadcastBots,
    broadcastGroups,
    projectSettingsForCwd,
    resolveCanonicalSessionFile,
    overlayForSessionFile,
    driveExtrasIO,
    lastAssistantText,
  } = deps;
  // -------------------------------------------------------------------------
  // Bot Mode (Hermes-style Bots: named specialists with a canonical chat)
  // -------------------------------------------------------------------------

  handle("pideck:bots-list", () => botStore.list());

  handle("pideck:bots-create", async (_e, input: { name: string; title?: string; description?: string; persona?: string; model?: { provider: string; modelId: string }; cwd?: string }) => {
    if (!input || typeof input.name !== "string") throw new Error("invalid bot");
    if (input.cwd !== undefined && typeof input.cwd !== "string") throw new Error("invalid bot home project");
    const created = botStore.create({
      name: input.name,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    });
    broadcastBots();
    return created;
  });

  handle("pideck:bots-update", async (_e, id: string, patch: Record<string, unknown>) => {
    if (typeof id !== "string" || !patch || typeof patch !== "object") throw new Error("invalid bot update");
    const allowed: Record<string, true> = {
      name: true, title: true, description: true, persona: true, model: true, cwd: true, hidden: true, mainSessionFile: true,
    };
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (allowed[k]) clean[k] = v;
    const updated = botStore.update(id, clean as Parameters<BotStore["update"]>[1]);
    broadcastBots();
    return updated;
  });

  handle("pideck:bots-delete", async (_e, id: string) => {
    if (typeof id !== "string") throw new Error("invalid bot id");
    const removed = botStore.remove(id);
    broadcastBots();
    return { removed };
  });

  handle("pideck:bots-open", async (_e, id: string, requestId?: number) => {
    if (typeof id !== "string") throw new Error("invalid bot id");
    if (isDaemonOwned()) throw new Error("Bot chats need the local runtime (turn off the daemon to use Bots)");
    if (getHostReady()) await getHostReady();
    const bot = botStore.get(id);
    if (!bot) throw new Error("Bot not found");
    getHost().setBotSystemPrompt(buildBotSystemPrompt(bot, botStore.list()));
    const cwd = bot.cwd && bot.cwd.length > 0 ? bot.cwd : getActiveCwd() || homedir();
    const projectHash = projectHashForCwd(cwd);
    // Per-project chat first, legacy canonical second (owned-or-on-disk).
    const path = await resolveCanonicalSessionFile(botChatForProject(bot, projectHash));
    const state = (await getRuntime().openSession({ path, cwd, ...(requestId !== undefined ? { requestId } : {}) })) as {
      sessionFile?: string;
    } | null | undefined;
    const sessionFile = state?.sessionFile ?? null;
    if (sessionFile && sessionFile !== botChatForProject(bot, projectHash)) {
      botStore.setProjectSession(id, projectHash, sessionFile);
      broadcastBots();
    }
    if (bot.model) {
      try {
        await getHost().setModel(bot.model.provider, bot.model.modelId);
      } catch (err) {
        console.warn(`[pideck] bot model pin unavailable (${bot.model.provider}/${bot.model.modelId}):`, err);
      }
    }
    taskManager.resumeForSession(sessionFile);
    return { sessionFile, bot: botStore.get(id) };
  });

  // -------------------------------------------------------------------------
  // Group rooms: one shared session, serial member turns driven here.
  // -------------------------------------------------------------------------

  handle("pideck:groups-list", () => botStore.listGroups());

  handle("pideck:groups-create", async (_e, input: { name: string; memberIds: string[]; cwd?: string }) => {
    if (!input || typeof input.name !== "string" || !Array.isArray(input.memberIds)) {
      throw new Error("invalid group");
    }
    const created = botStore.createGroup({
      name: input.name,
      memberIds: input.memberIds,
      ...(typeof input.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
    });
    broadcastGroups();
    return created;
  });

  handle("pideck:groups-update", async (_e, id: string, patch: Record<string, unknown>) => {
    if (typeof id !== "string" || !patch || typeof patch !== "object") throw new Error("invalid group update");
    const clean: { name?: string; memberIds?: string[]; cwd?: string } = {};
    if (typeof patch.name === "string") clean.name = patch.name;
    if (Array.isArray(patch.memberIds)) clean.memberIds = patch.memberIds.filter((m): m is string => typeof m === "string");
    if (patch.cwd === undefined || typeof patch.cwd === "string") clean.cwd = (patch.cwd as string | undefined) ?? "";
    const updated = botStore.updateGroup(id, clean);
    broadcastGroups();
    return updated;
  });

  handle("pideck:groups-delete", async (_e, id: string) => {
    if (typeof id !== "string") throw new Error("invalid group id");
    const removed = botStore.removeGroup(id);
    broadcastGroups();
    return { removed };
  });

  /** Ensure the room session is live with the group overlay; create the
   *  canonical file on first open. Returns the room file (possibly unflushed). */
  async function ensureGroupRoom(groupId: string): Promise<{ sessionFile: string; group: NonNullable<ReturnType<BotStore["getGroup"]>>; members: NonNullable<ReturnType<BotStore["get"]>>[] }> {
    const group = botStore.getGroup(groupId);
    if (!group) throw new Error("Group not found");
    const members = group.memberIds
      .map((mid) => botStore.get(mid))
      .filter((b): b is NonNullable<typeof b> => !!b);
    if (members.length < 2) throw new Error("A group needs at least 2 bots");
    if (!group.projectHash) {
      // One-time anchor for pre-project groups; same fallback chain as cwd below.
      const anchorCwd = groupAnchorCwd(group, botStore.list()) ?? getActiveCwd() ?? homedir();
      try {
        botStore.updateGroup(group.id, { projectHash: projectHashForCwd(anchorCwd) });
        broadcastGroups();
      } catch {
        // Anchor persists on the next open instead.
      }
    }
    getHost().setBotSystemPrompt(buildGroupSystemPrompt(group, members));
    const cwd = group.cwd && group.cwd.length > 0 ? group.cwd : members[0]?.cwd && members[0].cwd.length > 0 ? members[0].cwd! : getActiveCwd() || homedir();
    const path = await resolveCanonicalSessionFile(group.mainSessionFile);
    const state = (await getRuntime().openSession({ path, cwd })) as { sessionFile?: string } | null | undefined;
    const sessionFile = state?.sessionFile ?? null;
    if (!sessionFile) throw new Error("could not open group room");
    if (sessionFile !== group.mainSessionFile) {
      botStore.setGroupRoom(groupId, sessionFile);
      broadcastGroups();
    }
    taskManager.resumeForSession(sessionFile);
    return { sessionFile, group: botStore.getGroup(groupId)!, members };
  }

  handle("pideck:groups-open", async (_e, id: string) => {
    if (typeof id !== "string") throw new Error("invalid group id");
    if (isDaemonOwned()) throw new Error("Group rooms need the local runtime (turn off the daemon to use Bots)");
    if (getHostReady()) await getHostReady();
    const { sessionFile, group } = await ensureGroupRoom(id);
    return { sessionFile, group };
  });

  handle("pideck:group-send", async (_e, groupId: string, text: string) => {
    if (typeof groupId !== "string" || typeof text !== "string" || !text.trim() || text.length > 200_000) {
      throw new Error("invalid group send");
    }
    if (isDaemonOwned()) throw new Error("Group rooms need the local runtime (turn off the daemon to use Bots)");
    if (getHostReady()) await getHostReady();
    if (getHost().isStreaming) throw new Error("The agent is busy, wait for this turn to finish");
    const { group, members } = await ensureGroupRoom(groupId);
    const runtime = getRuntime();
    // The user's message streams like any normal turn.
    await runtime.prompt(text);
    // Mention-only by default: extras speak only when asked. Projects that opt
    // into free-speak keep the legacy full rotation. Caps + quiet-settle live
    // in the driver; abort (or any turn failure) stops.
    const settings = group.projectHash ? projectSettings.getByHash(group.projectHash) : undefined;
    const freeSpeak = settings?.freeSpeak === true;
    const mentioned = new Set(
      parseBotMentions(text).flatMap((h) =>
        members.filter((m) => botHandle(m) === h || m.name.toLowerCase() === h).map((m) => m.id)
      )
    );
    const order = mentioned.size > 0 ? members.filter((m) => mentioned.has(m.id)) : freeSpeak ? members : [];
    if (order.length === 0) {
      return { rounds: 0, turns: 0, spoke: 0, stopped: false, sessionFile: group.mainSessionFile };
    }
    // Serial member turns as a mention-routed queue. The opening order is the
    // roster (or the mentioned subset); a spoke turn naming @someone jumps
    // them to the front, an explicit mention overrides a quiet streak, but
    // the turn/round caps still bound ping-pong loops. A drained queue
    // refills for the next round; an all-quiet drain settles the room.
    // Abort (or any turn failure) stops.
    const result = await driveRoomTurns({ groupId, members, order, io: driveExtrasIO() });
    return { ...result, sessionFile: group.mainSessionFile };
  });

  // -------------------------------------------------------------------------
  // Project settings + app-default (per-project bots metadata; userData side).
  // -------------------------------------------------------------------------

  handle("pideck:project-settings-get", async (_e, cwd: string) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("invalid cwd");
    const { settings, hash } = projectSettingsForCwd(cwd);
    return { settings: { ...settings, memberIds: settings.memberIds.filter((id: string) => botStore.get(id)) }, hash };
  });

  handle("pideck:project-settings-members", async (_e, hash: string, memberIds: string[]) => {
    if (typeof hash !== "string" || !Array.isArray(memberIds)) throw new Error("invalid project members");
    for (const id of memberIds) {
      if (typeof id !== "string" || !botStore.get(id)) throw new Error("Members must be existing bots");
    }
    return projectSettings.setMembers(hash, memberIds);
  });

  handle("pideck:project-settings-freespeak", async (_e, hash: string, on: boolean) => {
    if (typeof hash !== "string") throw new Error("invalid project");
    return projectSettings.setFreeSpeak(hash, on === true);
  });

  handle("pideck:project-default-update", async (_e, hash: string, patch: Record<string, unknown>) => {
    if (typeof hash !== "string" || !patch || typeof patch !== "object") throw new Error("invalid default update");
    const allowed = ["name", "title", "description", "persona", "model"] as const;
    const clean: Record<string, unknown> = {};
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
    return projectSettings.updateDefaultBot(hash, clean as Parameters<ProjectSettingsStore["updateDefaultBot"]>[1]);
  });

  handle("pideck:project-default-reset", async (_e, hash: string) => {
    if (typeof hash !== "string") throw new Error("invalid project");
    return projectSettings.resetDefaultBot(hash, botStore.getDefaultBot());
  });

  const handoffStore = new HandoffStore(join(app.getPath("userData"), "pideck-state", "handoffs"));

  handle("pideck:handoff-create", async (_e, projectHash: string, sourceFile: string) => {
    if (typeof projectHash !== "string" || typeof sourceFile !== "string" || !sourceFile) {
      throw new Error("invalid handoff request");
    }
    const settings = projectSettings.getByHash(projectHash);
    if (!settings) throw new Error("Open the project first, it needs settings to author the handoff");
    const target = await validateSessionPath(sessionsRoot, sourceFile);
    const { messages } = await readSessionTail(target);
    const deltaText = transcriptText(messages);
    if (!deltaText.trim()) throw new Error("Nothing to summarize yet, the thread is still fresh");
    if (getHostReady()) await getHostReady();
    const summary = normalizeHandoffText(
      (await getHost().summarizeHandoff(buildHandoffPrompt(deltaText, settings.defaultBot))) ?? ""
    );
    if (!summary) throw new Error("Summarization came back empty, try again");
    return handoffStore.append(target, {
      summary,
      author: settings.defaultBot.name,
      sourceChars: deltaText.length,
    });
  });

  handle("pideck:handoff-list", async (_e, sourceFile: string) => {
    if (typeof sourceFile !== "string" || !sourceFile) throw new Error("invalid handoff request");
    const target = await validateSessionPath(sessionsRoot, sourceFile);
    return handoffStore.forSource(target);
  });

  handle("pideck:handoff-consume", async (_e, handoffId: string, liveFile: string) => {
    if (typeof handoffId !== "string" || typeof liveFile !== "string" || !liveFile) {
      throw new Error("invalid handoff request");
    }
    const handoff = await handoffStore.findById(handoffId);
    if (!handoff) throw new Error("Handoff not found");
    const live = await validateSessionPath(sessionsRoot, liveFile);
    if (getHostReady()) await getHostReady();
    if (getHost().isStreaming) throw new Error("Wait for the live turn to finish first");
    const estimatedTokensBefore = Math.max(1, Math.round(handoff.sourceChars / 4));
    const estimatedTokensAfter = Math.max(1, Math.round(handoff.summary.length / 4));
    await getHost().consumeHandoff(live, handoff.summary, estimatedTokensBefore);
    await handoffStore.markConsumed(handoffId, live);
    getHost().emitHandoffEvent({
      type: "babylon_handoff_consumed",
      handoffId,
      sourceName: handoff.sourceFile.split("/").pop() ?? handoff.sourceFile,
      author: handoff.author,
      tokensBefore: estimatedTokensBefore,
      estimatedTokensAfter,
    });
    sessionIndex.touch();
    return { consumedInto: live };
  });

  handle("pideck:bots-default-get", () => botStore.getDefaultBot());

  handle("pideck:bots-default-set", async (_e, input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("invalid default bot");
    const updated = botStore.setDefaultBot(input as Parameters<BotStore["setDefaultBot"]>[0]);
    broadcastBots();
    return updated;
  });

  // -------------------------------------------------------------------------
  // Bot-to-bot DM: one attributed turn in the target's chat, reply relayed
  // into the origin as a bot-message line. Idle sessions only, the single
  // runtime cannot background turns, so delivery is synchronous and visible.
  // -------------------------------------------------------------------------

  handle("pideck:bots-message", async (_e, targetId: string, text: string, fromId?: string) => {
    if (typeof targetId !== "string" || typeof text !== "string" || !text.trim() || text.length > 200_000) {
      throw new Error("invalid bot message");
    }
    if (isDaemonOwned()) throw new Error("Bot chats need the local runtime (turn off the daemon to use Bots)");
    if (getHostReady()) await getHostReady();
    const target = botStore.get(targetId);
    if (!target) throw new Error("Bot not found");
    const from = typeof fromId === "string" ? botStore.get(fromId) : undefined;
    if (getHost().isStreaming) throw new Error("The agent is busy, wait for this turn to finish");
    const origin = getHost().activeSessionFile;
    if (!origin) throw new Error("Open a chat first, replies need a home");
    const originCwd = getHost().cwd;
    // Run the target turn in the target's canonical chat.
    getHost().setBotSystemPrompt(buildBotSystemPrompt(target, botStore.list()));
    const targetCwd = target.cwd && target.cwd.length > 0 ? target.cwd : getActiveCwd() || homedir();
    const targetHash = projectHashForCwd(targetCwd);
    const targetPath = await resolveCanonicalSessionFile(botChatForProject(target, targetHash));
    const targetState = (await getRuntime().openSession({ path: targetPath, cwd: targetCwd })) as {
      sessionFile?: string;
    } | null | undefined;
    const targetFile = targetState?.sessionFile ?? null;
    if (targetFile && targetFile !== botChatForProject(target, targetHash)) {
      botStore.setProjectSession(targetId, targetHash, targetFile);
      broadcastBots();
    }
    if (target.model) {
      try {
        await getHost().setModel(target.model.provider, target.model.modelId);
      } catch (err) {
        console.warn(`[pideck] bot model pin unavailable (${target.model.provider}/${target.model.modelId}):`, err);
      }
    }
    const sender = from ? `@${botHandle(from)} (${from.name})` : "you (the human)";
    await getRuntime().prompt(`[DM from ${sender}, reply briefly in your voice, or PASS if nothing to add]\n\n${text}`);
    const reply = lastAssistantText(await getRuntime().getMessages());
    const pass = isPassReply(reply);
    // Switch home and relay the reply as an attributed activity line.
    getHost().setBotSystemPrompt(overlayForSessionFile(origin, originCwd));
    await getRuntime().openSession({ path: origin, cwd: originCwd });
    if (!pass) {
      const clipped = reply.length > 6000 ? `${reply.slice(0, 6000)}\n… (truncated, full reply lives in @${botHandle(target)}'s chat)` : reply;
      await getHost().postBotMessage(
        `[Babylon Bot Message]\n@${from ? botHandle(from) : "you"} asked @${botHandle(target)}: ${text.length > 500 ? `${text.slice(0, 500)}…` : text}\n\n@${botHandle(target)} replied:\n\n${clipped}`,
        { fromId: from?.id ?? null, targetId, text: text.slice(0, 500) }
      );
    }
    taskManager.resumeForSession(origin);
    sessionIndex.touch();
    return { reply: pass ? null : reply, pass };
  });
}
