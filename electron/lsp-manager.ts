// Project-scoped LSP diagnostics loop.
// Single owner of language-server children, watched documents, diagnostics,
// restart state, and immutable snapshots. Renderer reads snapshots over IPC;
// filesystem changes drive didOpen/didChange notifications.

import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeLspMessages, encodeLspMessage, mapDiagnostics, type LspMessage, type NormalizedDiagnostic } from "./lsp";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LspServerStatus = "unavailable" | "starting" | "running" | "crashed" | "stopped";

export interface LanguageDescriptor {
  language: string;
  extensions: string[];
  commands: Array<{ command: string; args: string[] }>;
}

export interface LspServerSnapshot {
  language: string;
  command: string;
  args: string[];
  pid?: number;
  status: LspServerStatus;
  /** Bounded status text (stderr tail or error). Never HTML. */
  message?: string;
  restartCount: number;
  diagnostics: NormalizedDiagnostic[];
}

export interface LspProjectSnapshot {
  cwd: string;
  updatedAt: number;
  diagnostics: NormalizedDiagnostic[];
  servers: LspServerSnapshot[];
}

export type LspUpdateCallback = (snapshots: LspProjectSnapshot[]) => void;

// ---------------------------------------------------------------------------
// Constants / caps
// ---------------------------------------------------------------------------

/** Initial file discovery is capped so a huge monorepo cannot exhaust memory or block startup.
 *  Document the cap in code as requested: this bounds the number of didOpen notifications
 *  on first project open. The watcher still covers the tree afterward. */
export const MAX_INITIAL_FILES = 5000;
export const MAX_FILE_SIZE = 1024 * 1024; // 1 MiB — never read giant/binary files
const DEBOUNCE_MS = 120;
const RESTART_BACKOFF_MS = 350;
const MAX_RESTARTS = 2;
const REQUEST_TIMEOUT_MS = 5000;
const STDERR_TAIL_MAX = 2000;
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "cache",
  "vendor",
  ".parcel-cache",
  "coverage",
  "target",
  ".hg",
  ".svn",
]);

// ---------------------------------------------------------------------------
// Default language descriptors (data-driven, injectable in tests)
// ---------------------------------------------------------------------------

export const defaultDescriptors: LanguageDescriptor[] = [
  {
    language: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    commands: [
      // Prefer project-local bin; fallback to global. Existence is probed at start().
      { command: "typescript-language-server", args: ["--stdio"] },
    ],
  },
  {
    language: "python",
    extensions: [".py"],
    commands: [{ command: "pyright-langserver", args: ["--stdio"] }],
  },
  {
    language: "go",
    extensions: [".go"],
    commands: [{ command: "gopls", args: [] }],
  },
  {
    language: "rust",
    extensions: [".rs"],
    commands: [{ command: "rust-analyzer", args: [] }],
  },
];

function commandsForDescriptor(cwd: string, d: LanguageDescriptor): Array<{ command: string; args: string[] }> {
  // For JS/TS and Python prefer project-local .bin first when it exists.
  if (d.language === "typescript") {
    const local = join(cwd, "node_modules", ".bin", "typescript-language-server");
    if (existsSync(local)) return [{ command: local, args: ["--stdio"] }, ...d.commands];
  }
  if (d.language === "python") {
    const local = join(cwd, "node_modules", ".bin", "pyright-langserver");
    if (existsSync(local)) return [{ command: local, args: ["--stdio"] }, ...d.commands];
  }
  return d.commands;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateCwd(cwd: unknown): string {
  if (typeof cwd !== "string") throw new Error("invalid cwd");
  if (cwd.length === 0 || cwd.length > 4096) throw new Error("invalid cwd");
  if (cwd.includes("\0")) throw new Error("invalid cwd");
  if (!isAbsolute(cwd)) throw new Error("invalid cwd");
  if (!existsSync(cwd)) throw new Error("invalid cwd");
  try {
    const st = statSync(cwd);
    if (!st.isDirectory()) throw new Error("invalid cwd");
  } catch (e) {
    if ((e as Error).message === "invalid cwd") throw e;
    throw new Error("invalid cwd");
  }
  return cwd;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type SpawnFn = (command: string, args: string[], opts: { cwd: string }) => ChildProcess;

interface DocState {
  uri: string;
  version: number;
  language: string;
  content: string;
}

interface ServerHandle {
  language: string;
  descriptor: LanguageDescriptor;
  command: string;
  args: string[];
  status: LspServerStatus;
  pid?: number;
  message?: string;
  restartCount: number;
  child: ChildProcess | null;
  buffer: Buffer;
  pending: Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  nextId: number;
  stderrTail: string;
  shouldStop: boolean;
  epoch: number;
  startGeneration: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

interface Project {
  cwd: string;
  epoch: number;
  updatedAt: number;
  servers: Map<string, ServerHandle>;
  diagnostics: Map<string, NormalizedDiagnostic[]>; // uri -> diagnostics
  docs: Map<string, DocState>; // filePath -> DocState
  versionByPath: Map<string, number>;
  watchers: Array<{ close(): void }>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pendingChanges: Set<string>;
  disposed: boolean;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class LspManager {
  private projects = new Map<string, Project>();
  private activeCwd: string | null = null;
  private epochCounter = 0;
  private listeners = new Set<LspUpdateCallback>();
  private descriptors: LanguageDescriptor[];
  private spawnFn: SpawnFn;
  private onNewDiagnosticsForPi?: (cwd: string, diagnostics: NormalizedDiagnostic[]) => void;
  private prevDiagnosticsForPi = new Map<string, NormalizedDiagnostic[]>();
  private piDebounce: ReturnType<typeof setTimeout> | null = null;
  private piPending = new Map<string, NormalizedDiagnostic[]>();

  constructor(opts?: { descriptors?: LanguageDescriptor[]; spawnFn?: SpawnFn }) {
    this.descriptors = opts?.descriptors ?? defaultDescriptors;
    this.spawnFn =
      opts?.spawnFn ??
      ((command, args, spawnOpts) =>
        defaultSpawn(command, args, {
          cwd: spawnOpts.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        } as never) as unknown as ChildProcess);
  }

  /** Inject callback that feeds newly introduced error/warning diagnostics to Pi. */
  setPiNotifier(fn: (cwd: string, diagnostics: NormalizedDiagnostic[]) => void): void {
    this.onNewDiagnosticsForPi = fn;
  }

  subscribe(cb: LspUpdateCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  listSnapshots(): LspProjectSnapshot[] {
    return [...this.projects.values()].map((p) => this.snapshotOf(p));
  }

  getSnapshot(cwd: string): LspProjectSnapshot | null {
    const p = this.projects.get(cwd);
    return p ? this.snapshotOf(p) : null;
  }

  getActiveSnapshot(): LspProjectSnapshot | null {
    if (!this.activeCwd) return null;
    return this.getSnapshot(this.activeCwd);
  }

  /** Set the active project. Stops old servers/watchers and epoch-guards stale callbacks. */
  async setActiveProject(cwd: string | null): Promise<LspProjectSnapshot | null> {
    if (cwd === null) {
      if (this.activeCwd) {
        const old = this.projects.get(this.activeCwd);
        if (old) this.disposeProject(old);
      }
      this.activeCwd = null;
      this.broadcast();
      return null;
    }
    const validated = validateCwd(cwd);
    if (this.activeCwd === validated) return this.getSnapshot(validated);

    // Stop old project ownership
    if (this.activeCwd) {
      const old = this.projects.get(this.activeCwd);
      if (old) this.disposeProject(old);
    }
    this.activeCwd = validated;
    this.epochCounter++;

    let project = this.projects.get(validated);
    if (!project) {
      project = this.createProject(validated, this.epochCounter);
      this.projects.set(validated, project);
      // Kick off discovery + watching without blocking. Snapshots update when done.
      void this.discoverAndWatch(project).catch(() => undefined);
    }
    this.broadcast();
    return this.snapshotOf(project);
  }

  /** Explicit refresh: retry unavailable/crashed servers and re-scan files. */
  async refresh(cwd: string): Promise<LspProjectSnapshot> {
    const validated = validateCwd(cwd);
    let project = this.projects.get(validated);
    if (!project) {
      this.epochCounter++;
      project = this.createProject(validated, this.epochCounter);
      this.projects.set(validated, project);
      await this.discoverAndWatch(project);
      this.broadcast();
      return this.snapshotOf(project);
    }
    // Reset crashed/unavailable servers so they may retry. Await each attempt so
    // refresh returns a terminal result rather than exposing an in-flight spawn
    // that disposal can race.
    const retries: Promise<void>[] = [];
    for (const server of project.servers.values()) {
      if (server.status === "crashed" || server.status === "unavailable") {
        server.status = "starting";
        server.message = undefined;
        server.restartCount = Math.min(server.restartCount, MAX_RESTARTS - 1);
        server.shouldStop = false;
        server.epoch = project.epoch;
        retries.push(this.startServer(project, server));
      }
    }
    await Promise.all(retries);
    // If no servers yet, re-discover
    if (project.servers.size === 0) {
      await this.discoverAndWatch(project);
    } else {
      // Re-send didChange for watched docs to force fresh diagnostics
      for (const server of project.servers.values()) {
        if (server.status === "running") {
          for (const [filePath, doc] of project.docs) {
            if (this.descriptorForFile(filePath)?.language === server.language) {
              void this.notifyDidChange(project, server, filePath, doc).catch(() => undefined);
            }
          }
        }
      }
    }
    project.updatedAt = Date.now();
    this.broadcast();
    return this.snapshotOf(project);
  }

  dispose(): void {
    if (this.piDebounce) {
      clearTimeout(this.piDebounce);
      this.piDebounce = null;
    }
    this.piPending.clear();
    this.prevDiagnosticsForPi.clear();
    for (const p of this.projects.values()) this.disposeProject(p);
    this.projects.clear();
    this.activeCwd = null;
    this.listeners.clear();
  }

  /** For tests: wait until project has expected server status or timeout. */
  async waitForServerStatus(
    cwd: string,
    language: string,
    predicate: (s: LspServerSnapshot) => boolean,
    timeoutMs = 3000
  ): Promise<LspServerSnapshot> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = this.getSnapshot(cwd);
      const s = snap?.servers.find((x) => x.language === language);
      if (s && predicate(s)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`waitForServerStatus timeout for ${language} in ${cwd}`);
  }

  // -------------------------------------------------------------------------
  // Project lifecycle helpers
  // -------------------------------------------------------------------------

  private createProject(cwd: string, epoch: number): Project {
    return {
      cwd,
      epoch,
      updatedAt: Date.now(),
      servers: new Map(),
      diagnostics: new Map(),
      docs: new Map(),
      versionByPath: new Map(),
      watchers: [],
      debounceTimer: null,
      pendingChanges: new Set(),
      disposed: false,
    };
  }

  private disposeProject(p: Project): void {
    p.disposed = true;
    this.piPending.delete(p.cwd);
    this.prevDiagnosticsForPi.delete(p.cwd);
    if (p.debounceTimer) {
      clearTimeout(p.debounceTimer);
      p.debounceTimer = null;
    }
    for (const w of p.watchers) {
      try {
        w.close();
      } catch {}
    }
    p.watchers = [];
    for (const s of p.servers.values()) {
      s.shouldStop = true;
      this.stopServer(p, s);
    }
    this.projects.delete(p.cwd);
  }

  private stopServer(_project: Project, server: ServerHandle): void {
    server.shouldStop = true;
    server.startGeneration++;
    if (server.restartTimer) {
      clearTimeout(server.restartTimer);
      server.restartTimer = null;
    }
    for (const pending of server.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("server stopped"));
    }
    server.pending.clear();
    const child = server.child;
    server.child = null;
    if (child) {
      // Send the protocol sequence before the bounded process fallback. App
      // shutdown cannot leave the kill on an unref'ed timer or orphan servers.
      this.writeToChild(child, { jsonrpc: "2.0", id: server.nextId++, method: "shutdown", params: null });
      this.writeToChild(child, { jsonrpc: "2.0", method: "exit", params: null });
      try {
        child.kill();
      } catch {}
    }
    server.status = "stopped";
    server.pid = undefined;
    server.buffer = Buffer.alloc(0);
  }

  private snapshotOf(p: Project): LspProjectSnapshot {
    const allDiagnostics: NormalizedDiagnostic[] = [];
    for (const diags of p.diagnostics.values()) allDiagnostics.push(...diags);

    const servers: LspServerSnapshot[] = [...p.servers.values()].map((s) => ({
      language: s.language,
      command: s.command,
      args: [...s.args],
      pid: s.pid,
      status: s.status,
      message: s.message,
      restartCount: s.restartCount,
      diagnostics: allDiagnostics.filter((d) => this.fileMatchesLanguage(d.file, s.language)),
    }));

    return {
      cwd: p.cwd,
      updatedAt: p.updatedAt,
      diagnostics: [...allDiagnostics],
      servers,
    };
  }

  private fileMatchesLanguage(fileUri: string, language: string): boolean {
    const path = fileUriToPath(fileUri);
    const d = this.descriptorForFile(path);
    return d?.language === language;
  }

  private broadcast(): void {
    const snaps = this.listSnapshots();
    for (const cb of this.listeners) {
      try {
        cb(snaps);
      } catch {}
    }
  }

  private descriptorForFile(filePath: string): LanguageDescriptor | undefined {
    const lower = filePath.toLowerCase();
    for (const d of this.descriptors) {
      for (const ext of d.extensions) if (lower.endsWith(ext)) return d;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Discovery + watching
  // -------------------------------------------------------------------------

  private async discoverAndWatch(project: Project): Promise<void> {
    const files = await this.collectFiles(project.cwd, project);
    if (project.disposed || (project.epoch !== this.epochCounter && this.activeCwd !== project.cwd)) return;

    // Read files and populate docs map
    for (const filePath of files) {
      if (project.disposed) break;
      const doc = await this.readDoc(project, filePath);
      if (doc) project.docs.set(filePath, doc);
    }

    // Start servers lazily for languages that have matching files
    const languagesNeeded = new Set<string>();
    for (const filePath of project.docs.keys()) {
      const d = this.descriptorForFile(filePath);
      if (d) languagesNeeded.add(d.language);
    }
    for (const lang of languagesNeeded) {
      if (!project.servers.has(lang)) {
        const descriptor = this.descriptors.find((d) => d.language === lang)!;
        const handle = this.createServerHandle(project, descriptor);
        project.servers.set(lang, handle);
        void this.startServer(project, handle).catch(() => undefined);
      }
    }

    // If no servers needed, still record unavailable snapshot so UI is truthful?
    // Leave empty servers list — panel will show "No language servers" truthfully.
    project.updatedAt = Date.now();
    this.broadcast();

    // Install watchers (Node APIs only)
    this.installWatchers(project);
  }

  private async collectFiles(cwd: string, project: Project): Promise<string[]> {
    const out: string[] = [];
    const queue: string[] = [cwd];
    while (queue.length && out.length < MAX_INITIAL_FILES) {
      const dir = queue.shift()!;
      // Epoch guard
      if (project.disposed) break;
      let entries: Array<{ name: string; isDir: boolean }>;
      try {
        const dirents = await fsp.readdir(dir, { withFileTypes: true });
        entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
      } catch {
        continue;
      }
      for (const e of entries) {
        if (out.length >= MAX_INITIAL_FILES) break;
        const full = join(dir, e.name);
        if (e.isDir) {
          if (EXCLUDED_DIRS.has(e.name)) continue;
          // Also exclude dot dirs that are likely caches? Keep .git already excluded.
          queue.push(full);
        } else {
          const d = this.descriptorForFile(full);
          if (!d) continue;
          // Quick size check via stat
          try {
            const st = await fsp.stat(full);
            if (!st.isFile() || st.size > MAX_FILE_SIZE) continue;
          } catch {
            continue;
          }
          out.push(full);
        }
      }
    }
    return out;
  }

  private async readDoc(project: Project, filePath: string): Promise<DocState | null> {
    const descriptor = this.descriptorForFile(filePath);
    if (!descriptor) return null;
    let content: string;
    try {
      const buf = await fsp.readFile(filePath);
      if (buf.length > MAX_FILE_SIZE) return null;
      if (buf.includes(0)) return null; // binary
      content = buf.toString("utf8");
    } catch {
      return null;
    }
    const version = (project.versionByPath.get(filePath) ?? 0) + 1;
    project.versionByPath.set(filePath, version);
    const uri = pathToFileURL(filePath).href;
    return { uri, version, language: descriptor.language, content };
  }

  private installWatchers(project: Project): void {
    // Close prior watchers
    for (const w of project.watchers) try { w.close(); } catch {}
    project.watchers = [];

    // Use fs.watch with recursive where available; fallback to watching discovered dirs.
    // We add a watcher on cwd recursively (darwin/win) and per-dir watchers as fallback.
    try {
      const watcher = require("node:fs").watch(
        project.cwd,
        { recursive: true } as unknown as { recursive: boolean },
        (_event: string, filename: string | null) => {
          if (!filename) return;
          const full = join(project.cwd, filename);
          this.onFileEvent(project, full);
        }
      ) as unknown as { close(): void; on(event: string, cb: (e: Error) => void): void };
      if (watcher && typeof watcher.on === "function") watcher.on("error", () => {});
      project.watchers.push(watcher);
      return;
    } catch {
      // Fallback: watch each known dir shallow
    }

    // Fallback: poll dirs via readdir? Instead watch each discovered doc's dir.
    const dirs = new Set<string>();
    for (const fp of project.docs.keys()) dirs.add(dirname(fp));
    dirs.add(project.cwd);
    for (const dir of dirs) {
      try {
        const w = require("node:fs").watch(dir, (_event: string, filename: string | null) => {
          if (!filename) return;
          const full = join(dir, filename);
          this.onFileEvent(project, full);
        }) as { close(): void; on(event: string, cb: (e: Error) => void): void };
        if (w && typeof (w as unknown as { on?: unknown }).on === "function") (w as unknown as { on(e: string, cb: (e: Error) => void): void }).on("error", () => {});
        project.watchers.push(w);
      } catch {}
    }
  }

  private onFileEvent(project: Project, filePath: string): void {
    if (project.disposed) return;
    if (this.isExcludedPath(project.cwd, filePath)) return;
    const descriptor = this.descriptorForFile(filePath);
    // Also handle deletions: descriptor may be undefined but we previously watched it
    if (!descriptor && !project.docs.has(filePath)) return;

    project.pendingChanges.add(filePath);
    if (project.debounceTimer) clearTimeout(project.debounceTimer);
    project.debounceTimer = setTimeout(() => {
      project.debounceTimer = null;
      const batch = [...project.pendingChanges];
      project.pendingChanges.clear();
      void this.flushChanges(project, batch).catch(() => undefined);
    }, DEBOUNCE_MS);
    if (project.debounceTimer && typeof (project.debounceTimer as unknown as { unref?: () => void }).unref === "function") {
      (project.debounceTimer as unknown as { unref(): void }).unref();
    }
  }

  private isExcludedPath(projectCwd: string, filePath: string): boolean {
    const rel = relative(projectCwd, filePath);
    if (rel === "") return false;
    const parts = rel.split(/[\\/]+/);
    if (parts[0] === ".." || isAbsolute(rel)) return true;
    return parts.some((part) => EXCLUDED_DIRS.has(part));
  }

  private async flushChanges(project: Project, filePaths: string[]): Promise<void> {
    if (project.disposed) return;
    const epochAtStart = project.epoch;
    let changed = false;

    for (const filePath of filePaths) {
      if (project.disposed || project.epoch !== epochAtStart) return;
      const exists = existsSync(filePath);
      const hadDoc = project.docs.has(filePath);
      const descriptor = this.descriptorForFile(filePath);

      if (!exists) {
        if (hadDoc) {
          const doc = project.docs.get(filePath)!;
          project.docs.delete(filePath);
          project.diagnostics.delete(doc.uri);
          // Notify servers that had this doc
          for (const server of project.servers.values()) {
            if (server.status === "running" && server.language === doc.language) {
              this.sendNotification(server, "textDocument/didClose", { textDocument: { uri: doc.uri } });
            }
          }
          changed = true;
        }
        continue;
      }

      // Filter size/binary
      try {
        const st = await fsp.stat(filePath);
        if (!st.isFile() || st.size > MAX_FILE_SIZE) {
          if (hadDoc) {
            const doc = project.docs.get(filePath)!;
            project.docs.delete(filePath);
            project.diagnostics.delete(doc.uri);
            for (const server of project.servers.values()) {
              if (server.status === "running" && server.language === doc.language) {
                this.sendNotification(server, "textDocument/didClose", { textDocument: { uri: doc.uri } });
              }
            }
            changed = true;
          }
          continue;
        }
      } catch {
        continue;
      }

      let content: string;
      try {
        const buf = await fsp.readFile(filePath);
        if (buf.length > MAX_FILE_SIZE || buf.includes(0)) {
          if (hadDoc) {
            const doc = project.docs.get(filePath)!;
            project.docs.delete(filePath);
            project.diagnostics.delete(doc.uri);
            for (const server of project.servers.values()) {
              if (server.status === "running" && server.language === doc.language) {
                this.sendNotification(server, "textDocument/didClose", { textDocument: { uri: doc.uri } });
              }
            }
            changed = true;
          }
          continue;
        }
        content = buf.toString("utf8");
      } catch {
        continue;
      }

      if (!descriptor && !hadDoc) continue;

      // Ensure server exists for new language
      if (descriptor && !project.servers.has(descriptor.language)) {
        const handle = this.createServerHandle(project, descriptor);
        project.servers.set(descriptor.language, handle);
        void this.startServer(project, handle).catch(() => undefined);
      }

      if (!hadDoc) {
        const version = (project.versionByPath.get(filePath) ?? 0) + 1;
        project.versionByPath.set(filePath, version);
        const uri = pathToFileURL(filePath).href;
        const doc: DocState = { uri, version, language: descriptor!.language, content };
        project.docs.set(filePath, doc);
        // Lazy server may still be starting; queue didOpen after running
        // If server running, send didOpen; else it will didOpen on start
        for (const server of project.servers.values()) {
          if (server.language === descriptor!.language) {
            if (server.status === "running") {
              this.sendNotification(server, "textDocument/didOpen", {
                textDocument: { uri: doc.uri, languageId: this.languageId(descriptor!.language, filePath), version: doc.version, text: doc.content },
              });
            }
            // also save?
            break;
          }
        }
        changed = true;
      } else {
        const prev = project.docs.get(filePath)!;
        if (prev.content === content) continue;
        const version = (project.versionByPath.get(filePath) ?? 0) + 1;
        project.versionByPath.set(filePath, version);
        const next: DocState = { ...prev, content, version };
        project.docs.set(filePath, next);
        for (const server of project.servers.values()) {
          if (server.language === prev.language && server.status === "running") {
            void this.notifyDidChange(project, server, filePath, next).catch(() => undefined);
          }
        }
        // Also send didSave for servers that expect it
        for (const server of project.servers.values()) {
          if (server.language === prev.language && server.status === "running") {
            this.sendNotification(server, "textDocument/didSave", { textDocument: { uri: next.uri }, text: next.content });
          }
        }
        changed = true;
      }
    }

    if (changed) {
      project.updatedAt = Date.now();
      this.broadcast();
      this.schedulePiNotify(project);
    }
  }

  private languageId(language: string, filePath?: string): string {
    if (language === "typescript" && filePath) {
      const lower = filePath.toLowerCase();
      if (lower.endsWith(".tsx")) return "typescriptreact";
      if (lower.endsWith(".jsx")) return "javascriptreact";
      if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
      if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
    }
    if (language === "typescript") return "typescript";
    return language;
  }

  private async notifyDidChange(project: Project, server: ServerHandle, filePath: string, doc: DocState): Promise<void> {
    if (project.epoch !== server.epoch || project.disposed) return;
    this.sendNotification(server, "textDocument/didChange", {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: doc.content }],
    });
  }

  // -------------------------------------------------------------------------
  // Server lifecycle
  // -------------------------------------------------------------------------

  private createServerHandle(project: Project, descriptor: LanguageDescriptor): ServerHandle {
    const cmds = commandsForDescriptor(project.cwd, descriptor);
    const primary = cmds[0];
    return {
      language: descriptor.language,
      descriptor,
      command: primary.command,
      args: [...primary.args],
      status: "starting",
      restartCount: 0,
      child: null,
      buffer: Buffer.alloc(0),
      pending: new Map(),
      nextId: 1,
      stderrTail: "",
      shouldStop: false,
      epoch: project.epoch,
      startGeneration: 0,
      restartTimer: null,
    };
  }

  private async startServer(project: Project, server: ServerHandle): Promise<void> {
    if (project.disposed || project.epoch !== server.epoch || server.shouldStop) return;

    const generation = ++server.startGeneration;
    const cmds = commandsForDescriptor(project.cwd, server.descriptor);
    let lastError: string | undefined;

    for (const candidate of cmds) {
      if (!this.isCurrentStart(project, server, generation)) return;
      server.command = candidate.command;
      server.args = [...candidate.args];
      server.status = "starting";
      server.message = undefined;
      server.buffer = Buffer.alloc(0);
      project.updatedAt = Date.now();
      this.broadcast();

      const started = await this.trySpawn(project, server, candidate, generation);
      if (started === "spawned" || started === "stale" || started === "terminated") return;
      lastError = server.message;
    }

    if (!this.isCurrentStart(project, server, generation)) return;
    server.status = "unavailable";
    server.message = lastError ?? "language server unavailable";
    server.pid = undefined;
    server.child = null;
    project.updatedAt = Date.now();
    this.broadcast();
  }

  private isCurrentStart(project: Project, server: ServerHandle, generation: number): boolean {
    return !project.disposed && project.epoch === server.epoch && !server.shouldStop && server.startGeneration === generation;
  }

  private async trySpawn(
    project: Project,
    server: ServerHandle,
    candidate: { command: string; args: string[] },
    generation: number
  ): Promise<"spawned" | "failed" | "stale" | "terminated"> {
    if (!this.isCurrentStart(project, server, generation)) return "stale";

    let child: ChildProcess;
    try {
      child = this.spawnFn(candidate.command, candidate.args, { cwd: project.cwd });
    } catch (cause) {
      server.message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
      return "failed";
    }

    const spawnResult = await new Promise<{ ok: true } | { ok: false; error: Error }>((resolve) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve({ ok: true });
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        resolve({ ok: false, error });
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    if (!spawnResult.ok) {
      if (this.isCurrentStart(project, server, generation)) {
        server.message = spawnResult.error.message.slice(0, 500);
        server.pid = undefined;
      }
      return "failed";
    }

    if (!this.isCurrentStart(project, server, generation)) {
      try { child.kill(); } catch {}
      return "stale";
    }

    server.child = child;
    server.pid = child.pid;
    server.buffer = Buffer.alloc(0);
    server.pending.clear();

    const stderr = child.stderr;
    if (stderr) {
      stderr.on("data", (chunk: Buffer | string) => {
        if (server.child !== child) return;
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        server.stderrTail = (server.stderrTail + text).slice(-STDERR_TAIL_MAX);
        server.message = server.stderrTail.slice(-500);
      });
    }
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      if (server.child === child) this.onServerData(project, server, chunk);
    });
    child.on("error", (error: Error) => {
      if (server.child === child) server.message = error.message.slice(0, 500);
    });
    child.once("close", (code, signal) => this.onServerClose(project, server, child, code, signal));

    try {
      await this.initializeServer(project, server);
    } catch (cause) {
      if (!this.isCurrentStart(project, server, generation)) return "stale";
      if (server.child !== child) return "terminated";
      server.message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
      try { child.kill(); } catch {}
      return "terminated";
    }

    return this.isCurrentStart(project, server, generation) && server.child === child ? "spawned" : "terminated";
  }

  private async initializeServer(project: Project, server: ServerHandle): Promise<void> {
    const rootUri = pathToFileURL(project.cwd).href;
    const result = await this.sendRequest(project, server, "initialize", {
      processId: server.pid ?? null,
      rootUri,
      rootPath: project.cwd,
      capabilities: {
        workspace: { configuration: true },
        textDocument: { publishDiagnostics: { relatedInformation: true } },
      },
      workspaceFolders: [{ uri: rootUri, name: basename(project.cwd) || project.cwd }],
      initializationOptions: {},
    });
    if (project.epoch !== server.epoch || project.disposed || server.shouldStop) return;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void result;
    this.sendNotification(server, "initialized", {});
    server.status = "running";
    server.message = undefined;
    project.updatedAt = Date.now();
    this.broadcast();

    // didOpen for all matching docs
    for (const [filePath, doc] of project.docs) {
      if (project.epoch !== server.epoch) break;
      const d = this.descriptorForFile(filePath);
      if (!d || d.language !== server.language) continue;
      this.sendNotification(server, "textDocument/didOpen", {
        textDocument: { uri: doc.uri, languageId: this.languageId(d.language, filePath), version: doc.version, text: doc.content },
      });
    }
  }

  private onServerData(project: Project, server: ServerHandle, chunk: Buffer): void {
    if (project.epoch !== server.epoch || project.disposed) return;
    server.buffer = Buffer.concat([server.buffer, chunk]);
    const decoded = decodeLspMessages(server.buffer);
    server.buffer = decoded.rest;
    for (const msg of decoded.messages) {
      void this.handleServerMessage(project, server, msg);
    }
  }

  private async handleServerMessage(project: Project, server: ServerHandle, msg: LspMessage): Promise<void> {
    if (project.epoch !== server.epoch || project.disposed) return;

    // Response to our request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = server.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        server.pending.delete(msg.id);
        if (msg.error !== undefined) pending.reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
      return;
    }

    // Server -> client request (must reply to avoid hangs)
    if (msg.id !== undefined && typeof msg.method === "string") {
      const id = msg.id;
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        const params = msg.params as { items?: unknown[] } | undefined;
        const count = Array.isArray(params?.items) ? params.items.length : 0;
        result = Array(count).fill(null);
      } else if (msg.method === "client/registerCapability" || msg.method === "client/unregisterCapability") {
        result = null;
      } else if (msg.method === "window/workDoneProgress/create") {
        result = null;
      }
      this.sendJson(server, { jsonrpc: "2.0", id, result });
      return;
    }

    // Notification
    if (typeof msg.method === "string") {
      if (msg.method === "textDocument/publishDiagnostics") {
        const params = msg.params as { uri: string; diagnostics: Array<import("./lsp").RawLspDiagnostic> } | undefined;
        if (!params || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return;
        // Epoch guard: drop diagnostics from stale project
        if (project.epoch !== server.epoch || project.disposed) return;
        const normalized = mapDiagnostics(params.uri, params.diagnostics);
        project.diagnostics.set(params.uri, normalized);
        // Prune empty diagnostics? keep empty to represent cleared
        if (normalized.length === 0) {
          // Keep empty entry so snapshot aggregates correctly; but also allow deletion
        }
        project.updatedAt = Date.now();
        this.broadcast();
        this.schedulePiNotify(project);
        return;
      }
      if (msg.method === "window/logMessage" || msg.method === "window/showMessage") {
        const params = msg.params as { message?: string } | undefined;
        if (params?.message) {
          server.message = String(params.message).slice(0, 500);
        }
        return;
      }
    }
  }

  private onServerClose(
    project: Project,
    server: ServerHandle,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (project.epoch !== server.epoch || server.child !== child) return;
    for (const pending of server.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("server closed"));
    }
    server.pending.clear();
    server.pid = undefined;
    server.child = null;
    server.buffer = Buffer.alloc(0);

    if (server.shouldStop) {
      server.status = "stopped";
      project.updatedAt = Date.now();
      this.broadcast();
      return;
    }

    // If ENOENT, treat as unavailable without restart loop
    const isEnoent = (server.message ?? server.stderrTail ?? "").includes("ENOENT") || server.stderrTail.includes("ENOENT");
    if (isEnoent) {
      server.status = "unavailable";
      server.message = (server.message ?? server.stderrTail ?? "spawn ENOENT").slice(0, 500);
      // Cap restarts to avoid looping
      server.restartCount = MAX_RESTARTS;
      project.updatedAt = Date.now();
      this.broadcast();
      return;
    }

    // Unexpected crash/close
    if (server.restartCount < MAX_RESTARTS) {
      server.restartCount++;
      server.status = "starting";
      server.message = signal ? `crashed (${signal}) — restarting` : `exited (${code ?? "unknown"}) — restarting`;
      project.updatedAt = Date.now();
      this.broadcast();
      const epochAtCrash = project.epoch;
      server.restartTimer = setTimeout(() => {
        server.restartTimer = null;
        if (project.disposed || project.epoch !== epochAtCrash || server.shouldStop) return;
        void this.startServer(project, server).catch(() => undefined);
      }, RESTART_BACKOFF_MS);
      server.restartTimer.unref?.();
    } else {
      server.status = "crashed";
      server.message = signal ? `crashed (${signal})` : `exited (${code ?? "unknown"})`;
      if (server.stderrTail) server.message = `${server.message}: ${server.stderrTail.slice(-400)}`;
      server.message = server.message.slice(0, 500);
      project.updatedAt = Date.now();
      this.broadcast();
    }
  }

  private sendRequest(project: Project, server: ServerHandle, method: string, params: unknown): Promise<unknown> {
    if (!server.child || server.shouldStop) return Promise.reject(new Error("server not running"));
    const id = server.nextId++;
    const msg: LspMessage = { jsonrpc: "2.0", id, method, params: params as Record<string, unknown> };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.pending.delete(id);
        reject(new Error(`request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      server.pending.set(id, { resolve, reject, timer });
      this.sendJson(server, msg);
    });
  }

  private sendNotification(server: ServerHandle, method: string, params: unknown): void {
    if (!server.child || server.shouldStop) return;
    const msg: LspMessage = { jsonrpc: "2.0", method, params: params as Record<string, unknown> };
    this.sendJson(server, msg);
  }

  private sendJson(server: ServerHandle, msg: LspMessage): void {
    if (server.child) this.writeToChild(server.child, msg);
  }

  private writeToChild(child: ChildProcess, msg: LspMessage): void {
    const stdin = child.stdin;
    if (!stdin || stdin.writableEnded || stdin.destroyed) return;
    try {
      stdin.write(encodeLspMessage(msg), () => {});
    } catch {
      // The close handler owns lifecycle state.
    }
  }

  // -------------------------------------------------------------------------
  // Pi diagnostics delivery (debounced, bounded, newly introduced only)
  // -------------------------------------------------------------------------

  private schedulePiNotify(project: Project): void {
    if (!this.onNewDiagnosticsForPi) return;
    const all = [...project.diagnostics.values()].flat();
    const errorsAndWarnings = all.filter((d) => d.severity === "error" || d.severity === "warning");
    // Debounced delivery
    this.piPending.set(project.cwd, errorsAndWarnings);
    if (this.piDebounce) clearTimeout(this.piDebounce);
    this.piDebounce = setTimeout(() => {
      this.piDebounce = null;
      for (const [cwd, diags] of this.piPending) {
        this.piPending.delete(cwd);
        const prev = this.prevDiagnosticsForPi.get(cwd) ?? [];
        // Only newly introduced diagnostics
        const nextSet = new Set(diags.map((d) => `${d.file}:${d.line}:${d.character}:${d.severity}:${d.message}:${d.source ?? ""}:${d.code ?? ""}`));
        const prevSet = new Set(prev.map((d) => `${d.file}:${d.line}:${d.character}:${d.severity}:${d.message}:${d.source ?? ""}:${d.code ?? ""}`));
        const newlyIntroduced = diags.filter((d) => !prevSet.has(`${d.file}:${d.line}:${d.character}:${d.severity}:${d.message}:${d.source ?? ""}:${d.code ?? ""}`));
        // Don't repeat unchanged set
        if (nextSet.size === prevSet.size && [...nextSet].every((k) => prevSet.has(k))) continue;
        this.prevDiagnosticsForPi.set(cwd, diags);
        if (newlyIntroduced.length === 0) continue;
        const bounded = newlyIntroduced.slice(0, 20);
        try {
          this.onNewDiagnosticsForPi!(cwd, bounded);
        } catch {}
      }
    }, 200);
    if (this.piDebounce && typeof (this.piDebounce as unknown as { unref?: () => void }).unref === "function") {
      (this.piDebounce as unknown as { unref(): void }).unref();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "file:") return fileURLToPath(url);
  } catch {}
  return uri;
}
