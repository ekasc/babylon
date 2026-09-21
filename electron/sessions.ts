import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wireOf, wireStr } from "../src/store";

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  firstUserText?: string;
  startedAt?: string;
  mtime: number;
  size: number;
  isWorktree?: boolean;
  parentPath?: string;
}

export interface ProjectGroup {
  cwd: string;
  sessions: SessionInfo[];
}

export interface SessionsUpdate {
  groups: ProjectGroup[];
  changedPaths: string[];
  version: number;
  source?: "filesystem" | "host";
}

interface CachedSession {
  signature: string;
  info: SessionInfo;
}

const EDGE_BYTES = 96 * 1024;

/** Incremental session index shared by sidebar IPC and filesystem updates. */
export class SessionIndex {
  readonly root: string;
  private cache = new Map<string, CachedSession>();
  private initialized = false;
  private version = 0;
  private watcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(update: SessionsUpdate) => void>();
  private scanning: Promise<SessionsUpdate> | null = null;
  private scheduledSource: "filesystem" | "host" = "filesystem";

  constructor(root = join(homedir(), ".pi", "agent", "sessions")) {
    this.root = root;
  }

  async list(): Promise<ProjectGroup[]> {
    if (!this.initialized) await this.rescan(false);
    return this.groups();
  }

  subscribe(listener: (update: SessionsUpdate) => void): () => void {
    this.listeners.add(listener);
    void this.start();
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (!this.initialized) await this.rescan(false);
    if (this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, () => this.scheduleRescan(300, "filesystem"));
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      // Recursive watch is unavailable on some platforms. The safety scan below
      // still guarantees eventual consistency without a hot polling loop.
    }
    this.safetyTimer ??= setInterval(() => void this.rescan(true), 15_000);
    this.safetyTimer.unref();
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    this.rescanTimer = null;
    this.safetyTimer = null;
    this.listeners.clear();
  }

  /** Re-index immediately after an in-process write instead of waiting for fs.watch. */
  touch(): void {
    this.scheduleRescan(40, "host");
  }

  private scheduleRescan(delay = 300, source: "filesystem" | "host" = "filesystem"): void {
    if (source === "host") this.scheduledSource = "host";
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      const nextSource = this.scheduledSource;
      this.scheduledSource = "filesystem";
      void this.rescan(true, nextSource);
    }, delay);
  }

  private rescan(emit: boolean, source: "filesystem" | "host" = "filesystem"): Promise<SessionsUpdate> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scanOnce(emit, source).finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async scanOnce(emit: boolean, source: "filesystem" | "host"): Promise<SessionsUpdate> {
    const files: string[] = [];
    let dirs: string[] = [];
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      // Sessions the app creates land flat at the root (SessionManager is
      // handed the root itself as sessionDir); only CLI-style layouts nest
      // them per project. A flat file the scan skips vanishes from the
      // session list, which drops its tab from the tab bar (buildTabItems
      // keeps tabs with a list entry only) even while the session is open.
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(this.root, entry.name));
      }
    } catch {
      const changedPaths = [...this.cache.keys()];
      this.cache.clear();
      this.initialized = true;
      if (changedPaths.length) this.version++;
      const update = { groups: [], changedPaths, version: this.version, source };
      if (emit && changedPaths.length) this.emit(update);
      return update;
    }

    await Promise.all(
      dirs.map(async (dir) => {
        const dirPath = join(this.root, dir);
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dirPath, entry.name));
          }
        } catch {
          // A directory may disappear between the root and child reads.
        }
      })
    );

    const seen = new Set(files);
    const changedPaths: string[] = [];
    const next = new Map<string, CachedSession>();
    await Promise.all(
      files.map(async (path) => {
        const stat = await fs.stat(path).catch(() => null);
        if (!stat?.isFile()) return;
        const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        const cached = this.cache.get(path);
        if (cached?.signature === signature) {
          next.set(path, cached);
          return;
        }
        const info = await readSessionInfo(path, stat.size, stat.mtimeMs);
        if (!info) return;
        next.set(path, { signature, info });
        changedPaths.push(path);
      })
    );

    for (const path of this.cache.keys()) {
      if (!seen.has(path)) changedPaths.push(path);
    }
    this.cache = next;
    this.initialized = true;
    if (changedPaths.length) this.version++;
    const update = { groups: this.groups(), changedPaths, version: this.version, source };
    if (emit && changedPaths.length) this.emit(update);
    return update;
  }

  private groups(): ProjectGroup[] {
    const grouped = new Map<string, SessionInfo[]>();
    for (const { info } of this.cache.values()) {
      const key = info.cwd || "(unknown)";
      const sessions = grouped.get(key) ?? [];
      sessions.push(info);
      grouped.set(key, sessions);
    }
    return [...grouped.entries()]
      .map(([cwd, sessions]) => ({ cwd, sessions: sessions.sort((a, b) => b.mtime - a.mtime) }))
      .sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
  }

  private emit(update: SessionsUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}

/** Backward-compatible one-shot listing helper used by startup. */
export async function listSessions(root?: string): Promise<ProjectGroup[]> {
  const index = new SessionIndex(root);
  try {
    return await index.list();
  } finally {
    index.dispose();
  }
}

async function readRange(path: string, start: number, length: number): Promise<string> {
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Read bounded head/tail metadata; large transcripts never block sidebar refreshes. */
export async function readSessionInfo(
  path: string,
  knownSize?: number,
  knownMtime?: number
): Promise<SessionInfo | null> {
  const stat =
    knownSize === undefined || knownMtime === undefined ? await fs.stat(path).catch(() => null) : null;
  const size = knownSize ?? stat?.size;
  const mtime = knownMtime ?? stat?.mtimeMs;
  if (size === undefined || mtime === undefined || size === 0) return null;

  try {
    const headLength = Math.min(size, EDGE_BYTES);
    const tailStart = Math.max(0, size - EDGE_BYTES);
    const [head, tailRaw] = await Promise.all([
      readRange(path, 0, headLength),
      tailStart > 0 ? readRange(path, tailStart, size - tailStart) : Promise.resolve(""),
    ]);
    // The first tail fragment may begin halfway through a JSON record.
    const tail = tailStart > 0 ? tailRaw.slice(Math.max(0, tailRaw.indexOf("\n") + 1)) : head;
    const headObjects = parseLines(head);
    const tailObjects = tailStart > 0 ? parseLines(tail) : headObjects;
    const header = headObjects.find((entry) => entry.type === "session");
    if (!header || typeof header.id !== "string") return null;

    let name: string | undefined;
    for (const entry of [...headObjects, ...tailObjects]) {
      if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
        name = entry.name.trim();
      }
    }
    let firstUserText: string | undefined;
    for (const entry of headObjects) {
      const message = wireOf(entry.message);
      if (entry.type !== "message" || message?.role !== "user") continue;
      const text = messageText(message?.content).trim();
      if (text) {
        firstUserText = truncate(text, 110);
        break;
      }
    }

    let lastMessageMs: number | null = null;
    for (const entry of [...headObjects, ...tailObjects]) {
      if (entry.type !== "message" || !entry.timestamp) continue;
      const t = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(t) && (lastMessageMs === null || t > lastMessageMs)) lastMessageMs = t;
    }
    const effectiveMtime = lastMessageMs !== null ? Math.max(mtime, lastMessageMs) : mtime;
    const sortMtime = lastMessageMs ?? mtime;

    return {
      id: header.id,
      path,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name: name ?? firstUserText,
      firstUserText,
      startedAt: typeof header.timestamp === "string" ? header.timestamp : undefined,
      mtime: sortMtime,
      size,
      isWorktree: !!header.parentSession,
      parentPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
    };
  } catch {
    return null;
  }
}

function parseLines(raw: string): Array<Record<string, unknown>> {
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      // Session lines are objects; anything else is a corrupt record.
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        parsed.push(value as Record<string, unknown>);
      }
    } catch {
      // A bounded edge can end in a partial record; later records remain usable.
    }
  }
  return parsed;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block === "string" ? block : String(wireOf(block)?.text ?? ""))).join("");
}

/** Non-diff tool output cap. Diffs (details.patch/diff) ship in full because
 *  they are the part the user actually reads; read/bash/etc. output is clamped
 *  here so the renderer never receives megabytes a collapsed card can't show. */
export const TOOL_OUTPUT_CLAMP = 16 * 1024;

/** Clamps tool-output text in one parsed message, in place. Returns the message. */
export function clampToolOutput(message: unknown): unknown {
  const m = wireOf(message);
  if (!m) return message;
  if (m.role === "toolResult" && Array.isArray(m.content)) {
    let used = 0;
    const kept: unknown[] = [];
    let truncated = false;
    for (const block of m.content) {
      const b = wireOf(block);
      if (!b || b.type !== "text") {
        kept.push(block);
        continue;
      }
      const text = String(b.text ?? "");
      const remaining = TOOL_OUTPUT_CLAMP - used;
      if (text.length <= remaining) {
        kept.push(block);
        used += text.length;
        continue;
      }
      if (remaining > 0) kept.push({ ...b, text: text.slice(0, remaining) });
      truncated = true;
      break; // the rest of the blocks are dropped from the wire view
    }
    if (truncated) {
      m.content = kept;
      m.truncated = true;
    }
  } else if (m.role === "bashExecution" && typeof m.output === "string" && m.output.length > TOOL_OUTPUT_CLAMP) {
    m.output = m.output.slice(0, TOOL_OUTPUT_CLAMP);
    m.truncated = true;
  }
  return message;
}

function projectMessages(entries: Array<Record<string, unknown>>): unknown[] {
  const messages: unknown[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      messages.push({
        ...(wireOf(clampToolOutput(entry.message)) ?? {}),
        entryId: entry.id,
        // Carry the entry's wall-clock time: recap merging interleaves by
        // timestamp, and recap scheduling keys off the newest message time.
        ...(Number.isFinite(ts) ? { timestamp: ts } : {}),
      });
    } else if (entry.type === "custom_message") {
      messages.push({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN,
      });
    }
  }
  return messages;
}

const TAIL_BYTES = 2 * 1024 * 1024;

/** Reads the tail of an append-only session file (last `maxBytes`, aligned to
 *  line boundaries) and projects the messages. Returns the byte offset of the
 *  first parsed line so older windows can be fetched on demand. */
export async function readSessionTail(path: string, maxBytes = TAIL_BYTES): Promise<{ messages: unknown[]; startOffset: number }> {
  return readSessionRange(path, undefined, maxBytes);
}

/** Reads a window of the file ending at `endOffset` (undefined = EOF), aligned
 *  to line boundaries. Cost is O(maxBytes), never O(file size). */
export async function readSessionRange(path: string, endOffset: number | undefined, maxBytes: number): Promise<{ messages: unknown[]; startOffset: number }> {
  try {
    const { size } = await fs.stat(path);
    const end = Math.min(endOffset ?? size, size);
    let window = maxBytes;
    for (;;) {
      const start = Math.max(0, end - window);
      const handle = await fs.open(path, "r");
      let text: string;
      try {
        const buf = Buffer.alloc(end - start);
        await handle.read(buf, 0, buf.length, start);
        text = buf.toString("utf8");
      } finally {
        await handle.close();
      }
      const firstLine = text.indexOf("\n");
      const from = firstLine === -1 ? 0 : firstLine + 1;
      const entries = parseLines(text.slice(from));
      if (entries.length || start === 0) {
        return { messages: projectMessages(entries), startOffset: start + from };
      }
      // The chunk ended on a boundary newline or mid-line (e.g. a multi-MB
      // tool output): extend the window backward until a complete line appears
      // or the file start is reached.
      window *= 2;
    }
  } catch {
    return { messages: [], startOffset: 0 };
  }
}

/** Reads one toolResult's full content straight from the file on demand.
 *  Used by the "show full output" affordance after W1 clamping. */
export async function readToolOutput(path: string, toolCallId: string, cap = 8 * 1024 * 1024): Promise<{ content: string; truncated: boolean }> {
  try {
    const raw = await fs.readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.includes(toolCallId)) continue;
      const entry = wireOf(parseJsonLine(line));
      if (!entry) continue;
      const m = wireOf(entry.message);
      if (wireStr(m, "toolCallId") !== toolCallId) continue;
      const content = messageText(m?.content);
      const truncated = content.length > cap;
      return { content: truncated ? content.slice(0, cap) : content, truncated };
    }
    throw new Error("Tool output not found");
  } catch (error: unknown) {
    throw new Error(`Failed to read tool output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parse one session-file line, undefined when corrupt (caller skips it). */
function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function truncate(value: string, length: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > length ? `${oneLine.slice(0, length - 1)}…` : oneLine;
}
