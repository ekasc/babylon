import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isSessionId, parseDurableGoalState, type DurableGoalModeConfig, type DurableGoalState } from "../../src/lib/durable-goal";

// Minimal vendor of the goal-mode feature-config convention: global
// `features/goal-mode.json` files override these defaults, then the trusted
// project file. Kept so existing behavior tuning keeps working now that the
// extension itself is hardbaked.
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override ?? base) as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(result[key]) && isPlainObject(value) ? mergeConfig(result[key], value) : value;
  }
  return result as T;
}

function globalFeatureConfigPaths(featureName: string): string[] {
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  return [join(agentDir, "features", `${featureName}.json`), join(dirname(agentDir), "features", `${featureName}.json`)];
}

export async function loadGoalModeConfig<T>(cwd: string, defaults: T, projectTrusted: boolean): Promise<T> {
  let merged = defaults;
  for (const path of globalFeatureConfigPaths("goal-mode")) {
    const loaded = await readJson<unknown | null>(path, null);
    if (loaded) merged = mergeConfig(merged, loaded);
  }
  if (projectTrusted) {
    const project = await readJson<unknown | null>(join(cwd, ".pi", "features", "goal-mode.json"), null);
    if (project) merged = mergeConfig(merged, project);
  }
  return merged;
}

/** Read a session's durable goal; null when none is set (or it is malformed). */
export async function loadSessionGoal(cwd: string, sessionId: string): Promise<DurableGoalState | null> {
  let path: string;
  try {
    path = goalFileForSession(cwd, sessionId);
  } catch {
    return null;
  }
  return parseDurableGoalState(await readJson<unknown>(path, null));
}

export async function saveSessionGoal(cwd: string, sessionId: string, state: DurableGoalState): Promise<void> {
  await writeJson(goalFileForSession(cwd, sessionId), state);
}

export async function clearSessionGoal(cwd: string, sessionId: string): Promise<void> {
  try {
    await rm(goalFileForSession(cwd, sessionId), { force: true });
  } catch {
    /* already gone */
  }
}

export type { DurableGoalModeConfig, DurableGoalState };

/** Absolute state-file path for a session. Throws on a hostile id (fail closed). */
export function goalFileForSession(cwd: string, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error("invalid session id for goal state");
  return join(cwd, ".pi", "state", "goal-mode", "sessions", `${sessionId}.json`);
}
