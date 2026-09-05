// Per-project settings: default-bot copy, staffed roster, free-speak flag.
// Storage: userData/projects/<hash>/settings.json (override dir with
// BABYLON_PROJECTS_DIR for tests). Project folders on disk are never touched.
// Identity key is the project hash (see projectHashForCwd); exact folder path
// means renames read as new projects (fresh snapshot, old state orphaned).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeProjectPathForComparison } from "../src/lib/path";
import { validateDefaultBot, type DefaultBot, type DefaultBotPatch } from "../src/bots";
import { botsPath } from "./bots";

export interface ProjectSettings {
  projectPath: string;
  defaultBot: DefaultBot;
  memberIds: string[];
  freeSpeak: boolean;
}

/** Canonical identity for an exact folder path. Realpath first so symlinked
 *  spellings (macOS /private, worktree links) hash together with the target. */
export function projectHashForCwd(cwd: string): string {
  const normalized = normalizeProjectPathForComparison(cwd.trim());
  let resolved = normalized;
  try {
    resolved = normalizeProjectPathForComparison(realpathSync(normalized));
  } catch {
    // Missing/unreadable path: hash the spelling; first successful open rekeys.
  }
  return createHash("sha256").update(resolved).digest("hex").slice(0, 24);
}

export function projectsDir(): string {
  if (process.env.BABYLON_PROJECTS_DIR) return process.env.BABYLON_PROJECTS_DIR;
  return join(dirname(botsPath()), "projects");
}

function sanitizeMembers(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((m): m is string => typeof m === "string" && m.length > 0))];
}

function sanitizeSettings(raw: unknown, fallbackPath: string): ProjectSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ProjectSettings>;
  const checked = validateDefaultBot((r.defaultBot ?? {}) as DefaultBot);
  if (!checked.ok) return null;
  return {
    projectPath: typeof r.projectPath === "string" && r.projectPath ? r.projectPath : fallbackPath,
    defaultBot: checked.value,
    memberIds: sanitizeMembers(r.memberIds),
    freeSpeak: r.freeSpeak === true,
  };
}

export class ProjectSettingsStore {
  private readonly dir: string;
  private cache = new Map<string, ProjectSettings>();

  constructor(dir?: string) {
    this.dir = dir ?? projectsDir();
  }

  private fileFor(hash: string): string {
    return join(this.dir, hash, "settings.json");
  }

  private write(hash: string, settings: ProjectSettings): ProjectSettings {
    const next = { ...settings, defaultBot: { ...settings.defaultBot }, memberIds: [...settings.memberIds] };
    this.cache.set(hash, next);
    try {
      const file = this.fileFor(hash);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").renameSync(tmp, file);
    } catch {
      // Persistence failure must not break the session: keep in-memory state.
    }
    return { ...next, defaultBot: { ...next.defaultBot }, memberIds: [...next.memberIds] };
  }

  /** Existing settings by hash, if any. No creation (hot-path reads). */
  getByHash(hash: string): ProjectSettings | undefined {
    try {
      const settings = this.require(hash);
      return { ...settings, defaultBot: { ...settings.defaultBot }, memberIds: [...settings.memberIds] };
    } catch {
      return undefined;
    }
  }

  /** Existing settings for a cwd, if any. No creation. */
  get(cwd: string): ProjectSettings | undefined {
    const hash = projectHashForCwd(cwd);
    const cached = this.cache.get(hash);
    if (cached) return { ...cached, defaultBot: { ...cached.defaultBot }, memberIds: [...cached.memberIds] };
    try {
      const file = this.fileFor(hash);
      if (!existsSync(file)) return undefined;
      const parsed = sanitizeSettings(JSON.parse(readFileSync(file, "utf8")), cwd);
      if (!parsed) return undefined;
      this.cache.set(hash, parsed);
      return { ...parsed, defaultBot: { ...parsed.defaultBot }, memberIds: [...parsed.memberIds] };
    } catch {
      return undefined;
    }
  }

  /** Snapshot the app-default into a new project on first open. Idempotent. */
  getOrCreate(cwd: string, appDefault: DefaultBot): { settings: ProjectSettings; hash: string; created: boolean } {
    const hash = projectHashForCwd(cwd);
    const existing = this.get(cwd);
    if (existing) return { settings: existing, hash, created: false };
    const checked = validateDefaultBot(appDefault);
    if (!checked.ok) throw new Error(checked.error);
    const created = this.write(hash, {
      projectPath: normalizeProjectPathForComparison(cwd.trim()),
      defaultBot: checked.value,
      memberIds: [],
      freeSpeak: false,
    });
    return { settings: created, hash, created: true };
  }

  /** Cached or on-disk settings; throws when the project was never opened. */
  private require(hash: string): ProjectSettings {
    const cached = this.cache.get(hash);
    if (cached) return cached;
    try {
      const file = this.fileFor(hash);
      if (existsSync(file)) {
        const parsed = sanitizeSettings(JSON.parse(readFileSync(file, "utf8")), hash);
        if (parsed) {
          this.cache.set(hash, parsed);
          return parsed;
        }
      }
    } catch {
      // Fall through to the not-found error below.
    }
    throw new Error("Project settings not found");
  }

  updateDefaultBot(hash: string, patch: DefaultBotPatch): ProjectSettings {
    const current = this.require(hash);
    const checked = validateDefaultBot({ ...current.defaultBot, ...patch });
    if (!checked.ok) throw new Error(checked.error);
    return this.write(hash, { ...current, defaultBot: checked.value });
  }

  resetDefaultBot(hash: string, appDefault: DefaultBot): ProjectSettings {
    const current = this.require(hash);
    const checked = validateDefaultBot(appDefault);
    if (!checked.ok) throw new Error(checked.error);
    return this.write(hash, { ...current, defaultBot: checked.value });
  }

  setMembers(hash: string, memberIds: string[]): ProjectSettings {
    const current = this.require(hash);
    return this.write(hash, { ...current, memberIds: sanitizeMembers(memberIds) });
  }

  setFreeSpeak(hash: string, on: boolean): ProjectSettings {
    const current = this.require(hash);
    return this.write(hash, { ...current, freeSpeak: on === true });
  }
}
