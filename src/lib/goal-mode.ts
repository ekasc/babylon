export interface GoalPos {
  x: number;
  y: number;
}

export interface GoalState {
  objective: string;
  startedAt: number;
  turns: number;
  done: boolean;
  doneAt?: number;
  pos?: GoalPos | null;
}

export type GoalMap = Record<string, GoalState>;

const KEY = "babylon:goal-mode:v1";

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      return (globalThis as any).localStorage as Store;
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function loadGoals(store: Store | null = defaultStore()): GoalMap {
  if (!store) return {};
  try {
    const raw = store.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: GoalMap = {};
    for (const [path, g] of Object.entries(parsed as Record<string, any>)) {
      if (!g || typeof g.objective !== "string" || typeof g.startedAt !== "number") continue;
      out[path] = {
        objective: g.objective,
        startedAt: g.startedAt,
        turns: typeof g.turns === "number" && g.turns >= 0 ? Math.floor(g.turns) : 0,
        done: g.done === true,
        ...(typeof g.doneAt === "number" ? { doneAt: g.doneAt } : {}),
        ...(g.pos && typeof g.pos.x === "number" && typeof g.pos.y === "number" ? { pos: { x: g.pos.x, y: g.pos.y } } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveGoals(map: GoalMap, store: Store | null = defaultStore()): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota or unavailable: goals stay in memory */
  }
}

/** Start (or restart) a goal for a session path. */
export function startGoal(map: GoalMap, path: string, objective: string, now: number = Date.now()): GoalMap {
  const clean = objective.trim();
  if (!path || !clean) return map;
  const prev = map[path];
  return {
    ...map,
    [path]: { objective: clean, startedAt: now, turns: 0, done: false, pos: prev?.pos ?? null },
  };
}

/** Count one assistant reply toward the session's goal. No-op without an open goal. */
export function bumpGoalTurn(map: GoalMap, path: string): GoalMap {
  const g = map[path];
  if (!g || g.done) return map;
  return { ...map, [path]: { ...g, turns: g.turns + 1 } };
}

/** Mark the goal done, freezing the elapsed clock. */
export function finishGoal(map: GoalMap, path: string, now: number = Date.now()): GoalMap {
  const g = map[path];
  if (!g || g.done) return map;
  return { ...map, [path]: { ...g, done: true, doneAt: now } };
}

export function clearGoal(map: GoalMap, path: string): GoalMap {
  if (!map[path]) return map;
  const next = { ...map };
  delete next[path];
  return next;
}

export function moveGoal(map: GoalMap, path: string, pos: GoalPos): GoalMap {
  const g = map[path];
  if (!g) return map;
  return { ...map, [path]: { ...g, pos } };
}

/** Elapsed ms toward the goal; frozen at doneAt once finished. */
export function goalElapsed(g: GoalState, now: number = Date.now()): number {
  return Math.max(0, (g.done && typeof g.doneAt === "number" ? g.doneAt : now) - g.startedAt);
}

/** H:MM:SS past the hour, M:SS before it. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
