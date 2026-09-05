// Electron-side Bot registry: persistence + CRUD over src/bots.ts.
// Storage: ~/.babylon/bots.json (override with BABYLON_BOTS_PATH for tests).
// Single JSON file, atomic write (tmp + rename), corrupt file -> empty registry.
// Per-bot agentDir/stateDir isolation is reserved on the Bot type but unset in
// v1; sessions still live in the shared pi sessions root so Sidebar,
// rollback, snapshots, and SessionIndex keep working unchanged.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createBot, createGroup, resolveBot, validateDefaultBot, type Bot, type BotGroup, type BotPatch, type DefaultBot, type NewBotInput, type NewGroupInput } from "../src/bots";

export type { Bot, BotGroup, BotPatch, NewBotInput, NewGroupInput };

export function botsPath(): string {
  if (process.env.BABYLON_BOTS_PATH) return process.env.BABYLON_BOTS_PATH;
  try {
    const { app } = require("electron") as typeof import("electron");
    if (app && typeof app.getPath === "function") {
      return join(app.getPath("userData"), "bots.json");
    }
  } catch {}
  return join(homedir(), ".babylon", "bots.json");
}

interface BotsFile {
  version: 1 | 2 | 3;
  bots: Bot[];
  groups?: BotGroup[];
  defaultBot?: DefaultBot;
}

/** Built-in fallback before the user edits the app-default (empty persona =
 *  today's default chat). */
export const FALLBACK_DEFAULT_BOT: DefaultBot = { name: "Assistant" };

function normalizeStored(raw: unknown): { bots: Bot[]; groups: BotGroup[]; defaultBot?: DefaultBot } {
  if (!raw || typeof raw !== "object") return { bots: [], groups: [] };
  const bots = (raw as Partial<BotsFile>).bots;
  const groups = (raw as Partial<BotsFile>).groups;
  const storedDefault = (raw as Partial<BotsFile>).defaultBot;
  let defaultBot: DefaultBot | undefined;
  if (storedDefault && typeof storedDefault === "object") {
    const checked = validateDefaultBot(storedDefault as DefaultBot);
    if (checked.ok) defaultBot = { ...checked.value };
  }
  return {
    bots: Array.isArray(bots)
      ? bots.filter(
          (b): b is Bot =>
            !!b && typeof b === "object" && typeof (b as Bot).id === "string" && typeof (b as Bot).name === "string"
        )
      : [],
    groups: Array.isArray(groups)
      ? groups.filter(
          (g): g is BotGroup =>
            !!g &&
            typeof g === "object" &&
            typeof (g as BotGroup).id === "string" &&
            typeof (g as BotGroup).name === "string" &&
            Array.isArray((g as BotGroup).memberIds)
        )
      : [],
    ...(defaultBot ? { defaultBot } : {}),
  };
}

export class BotStore {
  private bots: Bot[] = [];
  private groups: BotGroup[] = [];
  private defaultBot: DefaultBot | undefined;
  private listeners = new Set<(bots: Bot[]) => void>();
  private groupListeners = new Set<(groups: BotGroup[]) => void>();
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? botsPath();
    this.load();
  }

  subscribe(listener: (bots: Bot[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeGroups(listener: (groups: BotGroup[]) => void): () => void {
    this.groupListeners.add(listener);
    return () => this.groupListeners.delete(listener);
  }

  list(): Bot[] {
    return this.bots.map((b) => ({ ...b }));
  }

  get(id: string): Bot | undefined {
    const found = this.bots.find((b) => b.id === id);
    return found ? { ...found } : undefined;
  }

  resolve(ref: string): Bot | undefined {
    const found = resolveBot(this.bots, ref);
    return found ? { ...found } : undefined;
  }

  findBySessionFile(sessionFile: string | null | undefined): Bot | undefined {
    if (!sessionFile) return undefined;
    const found = this.bots.find((b) => b.mainSessionFile === sessionFile);
    return found ? { ...found } : undefined;
  }

  create(input: NewBotInput): Bot {
    const created = createBot(input);
    if ("error" in created) throw new Error(created.error);
    if (this.bots.some((b) => b.name.toLowerCase() === created.name.toLowerCase())) {
      throw new Error(`A bot named "${created.name}" already exists`);
    }
    this.bots = [...this.bots, created];
    this.save();
    return { ...created };
  }

  update(id: string, patch: BotPatch): Bot {
    const index = this.bots.findIndex((b) => b.id === id);
    if (index < 0) throw new Error("Bot not found");
    const current = this.bots[index]!;
    if (patch.name !== undefined) {
      const name = patch.name.trim().replaceAll(/\s+/g, " ");
      if (!name) throw new Error("Give the bot a name");
      if (
        this.bots.some((b) => b.id !== id && b.name.toLowerCase() === name.toLowerCase())
      ) {
        throw new Error(`A bot named "${name}" already exists`);
      }
    }
    if (patch.model !== undefined && patch.model !== null) {
      const m = patch.model as { provider?: string; modelId?: string };
      if (!m.provider?.trim() || !m.modelId?.trim()) throw new Error("Model pin needs both provider and model id");
    }
    const next: Bot = {
      ...current,
      ...patch,
      ...(patch.name ? { name: patch.name.trim().replaceAll(/\s+/g, " ") } : {}),
      updatedAt: Date.now(),
    };
    this.bots = [...this.bots.slice(0, index), next, ...this.bots.slice(index + 1)];
    this.save();
    return { ...next };
  }

  remove(id: string): boolean {
    if (!this.bots.some((b) => b.id === id)) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    this.save();
    return true;
  }

  setMainSession(id: string, sessionFile: string | null): Bot {
    return this.update(id, { mainSessionFile: sessionFile });
  }

  /** Record a bot's chat file for one project (v3 isolated chats). */
  setProjectSession(id: string, projectHash: string, sessionFile: string): Bot {
    const current = this.get(id);
    if (!current) throw new Error("Bot not found");
    return this.update(id, { sessionsByProject: { ...(current.sessionsByProject ?? {}), [projectHash]: sessionFile } });
  }

  /** Reverse lookup: which bot owns this file in its per-project map? */
  findByProjectSessionFile(sessionFile: string | null | undefined): { bot: Bot; projectHash: string } | undefined {
    if (!sessionFile) return undefined;
    for (const b of this.bots) {
      for (const [hash, file] of Object.entries(b.sessionsByProject ?? {})) {
        if (file === sessionFile) return { bot: { ...b }, projectHash: hash };
      }
    }
    return undefined;
  }

  /** App-default template (fallback when never edited). Always a copy. */
  getDefaultBot(): DefaultBot {
    return { ...(this.defaultBot ?? FALLBACK_DEFAULT_BOT) };
  }

  setDefaultBot(input: DefaultBot): DefaultBot {
    const checked = validateDefaultBot(input);
    if (!checked.ok) throw new Error(checked.error);
    this.defaultBot = { ...checked.value };
    this.save();
    return this.getDefaultBot();
  }

  // -- Groups ---------------------------------------------------------------

  listGroups(): BotGroup[] {
    return this.groups.map((g) => ({ ...g, memberIds: [...g.memberIds] }));
  }

  getGroup(id: string): BotGroup | undefined {
    const found = this.groups.find((g) => g.id === id);
    return found ? { ...found, memberIds: [...found.memberIds] } : undefined;
  }

  findGroupBySessionFile(sessionFile: string | null | undefined): BotGroup | undefined {
    if (!sessionFile) return undefined;
    const found = this.groups.find((g) => g.mainSessionFile === sessionFile);
    return found ? { ...found, memberIds: [...found.memberIds] } : undefined;
  }

  createGroup(input: NewGroupInput): BotGroup {
    const created = createGroup(input);
    if ("error" in created) throw new Error(created.error);
    if (this.groups.some((g) => g.name.toLowerCase() === created.name.toLowerCase())) {
      throw new Error(`A group named "${created.name}" already exists`);
    }
    for (const id of created.memberIds) {
      if (!this.bots.some((b) => b.id === id)) throw new Error("Group members must be existing bots");
    }
    this.groups = [...this.groups, created];
    this.save();
    return { ...created, memberIds: [...created.memberIds] };
  }

  updateGroup(id: string, patch: { name?: string; memberIds?: string[]; cwd?: string; mainSessionFile?: string | null; projectHash?: string }): BotGroup {
    const index = this.groups.findIndex((g) => g.id === id);
    if (index < 0) throw new Error("Group not found");
    const current = this.groups[index]!;
    if (patch.name !== undefined) {
      const name = patch.name.trim().replaceAll(/\s+/g, " ");
      if (!name) throw new Error("Give the group a name");
      if (this.groups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A group named "${name}" already exists`);
      }
    }
    if (patch.memberIds !== undefined) {
      const memberIds = [...new Set(patch.memberIds.filter((m) => typeof m === "string" && m))];
      if (memberIds.length < 2) throw new Error("A group needs at least 2 bots");
      if (memberIds.length > 6) throw new Error("A group holds at most 6 bots");
      for (const mid of memberIds) {
        if (!this.bots.some((b) => b.id === mid)) throw new Error("Group members must be existing bots");
      }
    }
    const next: BotGroup = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name.trim().replaceAll(/\s+/g, " ") } : {}),
      ...(patch.memberIds !== undefined ? { memberIds: [...new Set(patch.memberIds.filter((m) => typeof m === "string" && m))] } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd?.trim() ? patch.cwd.trim() : undefined } : {}),
      ...(patch.mainSessionFile !== undefined ? { mainSessionFile: patch.mainSessionFile } : {}),
      ...(patch.projectHash !== undefined ? { projectHash: patch.projectHash } : {}),
      updatedAt: Date.now(),
    };
    this.groups = [...this.groups.slice(0, index), next, ...this.groups.slice(index + 1)];
    this.save();
    return { ...next, memberIds: [...next.memberIds] };
  }

  removeGroup(id: string): boolean {
    if (!this.groups.some((g) => g.id === id)) return false;
    this.groups = this.groups.filter((g) => g.id !== id);
    this.save();
    return true;
  }

  setGroupRoom(id: string, sessionFile: string | null): BotGroup {
    return this.updateGroup(id, { mainSessionFile: sessionFile });
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) {
        this.bots = [];
        this.groups = [];
        return;
      }
      const stored = normalizeStored(JSON.parse(readFileSync(this.path, "utf8")));
      this.bots = stored.bots;
      this.groups = stored.groups;
      this.defaultBot = stored.defaultBot;
    } catch {
      this.bots = [];
      this.groups = [];
      this.defaultBot = undefined;
    }
  }

  private save(): void {
    const payload: BotsFile = {
      version: 3,
      bots: this.bots,
      groups: this.groups,
      ...(this.defaultBot ? { defaultBot: this.defaultBot } : {}),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      // Atomic-ish: rename over the previous file so a crash never leaves half JSON.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").renameSync(tmp, this.path);
    } catch {
      // Persistence failure must not break the session: keep in-memory state.
    }
    for (const l of this.listeners) {
      try {
        l(this.list());
      } catch {}
    }
    for (const l of this.groupListeners) {
      try {
        l(this.listGroups());
      } catch {}
    }
  }
}
