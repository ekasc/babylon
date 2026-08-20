// Browser Preview model for Runtime Workspace.
//
// When Babylon detects a local HTTP server (e.g. `pnpm dev` -> localhost:5173)
// it can offer an integrated preview. This module holds the detection heuristic
// and the tracked-server registry as pure, testable functions; the live port
// probing and the preview UI surface build on top.

export type ServerState = "starting" | "running" | "stopped";

export interface TrackedServer {
  id: string;
  url: string;
  port: number;
  ownerSession?: string;
  owner?: string;
  framework?: string;
  startedAt: number;
  state: ServerState;
}

export interface PreviewRegistry {
  servers: Record<string, TrackedServer>;
}

export function createPreviewRegistry(): PreviewRegistry {
  return { servers: {} };
}

export function registerServer(
  registry: PreviewRegistry,
  params: {
    id: string;
    port: number;
    ownerSession?: string;
    owner?: string;
    framework?: string;
    startedAt?: number;
    state?: ServerState;
  }
): PreviewRegistry {
  const server: TrackedServer = {
    id: params.id,
    url: `http://localhost:${params.port}`,
    port: params.port,
    ownerSession: params.ownerSession,
    owner: params.owner,
    framework: params.framework,
    startedAt: params.startedAt ?? 0,
    state: params.state ?? "starting",
  };
  return { servers: { ...registry.servers, [params.id]: server } };
}

export function updateServer(
  registry: PreviewRegistry,
  id: string,
  patch: Partial<Omit<TrackedServer, "id" | "port">>
): PreviewRegistry {
  const existing = registry.servers[id];
  if (!existing) return registry;
  return { servers: { ...registry.servers, [id]: { ...existing, ...patch } } };
}

export function removeServer(registry: PreviewRegistry, id: string): PreviewRegistry {
  const next = { ...registry.servers };
  delete next[id];
  return { servers: next };
}

export function listServers(registry: PreviewRegistry): TrackedServer[] {
  return Object.values(registry.servers);
}

/** Port each known framework dev server listens on by default. */
const FRAMEWORK_DEFAULT_PORT: Record<string, number> = {
  vite: 5173,
  next: 3000,
  "create-react-app": 3000,
  webpack: 8080,
  angular: 4200,
};

export interface DetectedServer {
  port: number;
  framework?: string;
}

/** Infer a framework from a command, word-bounded and context-aware for next. */
function inferFramework(command: string): string | undefined {
  const lower = command.toLowerCase();
  if (/\bvite\b/.test(lower)) return "vite";
  if (/\bwebpack\b/.test(lower)) return "webpack";
  if (/\bangular\b/.test(lower)) return "angular";
  // `next` is an ordinary English word, so only treat it as the framework when
  // it is followed by a server verb.
  if (/\bnext (?:dev|start|build|serve)\b/.test(lower)) return "next";
  return undefined;
}

/**
 * Best-effort port detection from a shell command. Honors an explicit
 * `--port[= ]N` (or Next's `-p[= ]N`), a `host:N` token that is not a
 * timestamp, then falls back to a known framework default or a generic package
 * manager dev script. Returns null when no server is implied. The module's own
 * live port probing is the authoritative source; this is a pre-detection hint.
 */
export function detectServerFromCommand(command: string): DetectedServer | null {
  const lower = command.toLowerCase();

  // Explicit --port N / --port=N (and Next's -p N / -p=N). Bare -p is avoided
  // so ssh -p / cp -p are not mistaken for a dev server.
  const explicit =
    command.match(/--port[=\s]+(\d{2,5})\b/) ?? lower.match(/\bnext\b[^\n]*?-p[=\s]+(\d{2,5})\b/);
  if (explicit) return { port: Number(explicit[1]), framework: inferFramework(command) };

  // host:port token, but only when the host looks like a host (not a timestamp
  // like 12:34). Trailing set includes URL path/bracket characters.
  const colon = lower.match(
    /(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3}|[a-z][\w.-]*):(\d{2,5})(?=[\s"')$,;:/]|$)/
  );
  if (colon) return { port: Number(colon[1]) };

  const framework = inferFramework(command);
  if (framework) return { port: FRAMEWORK_DEFAULT_PORT[framework], framework };

  // Generic package-manager dev script (most often Vite's 5173).
  if (/\b(?:pnpm|yarn|bun|npm)\b[^\n]*\bdev\b/i.test(command) && !/\/dev\//.test(lower)) {
    return { port: 5173, framework: "vite" };
  }
  return null;
}
