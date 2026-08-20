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

/** Framework defaults for common dev commands. */
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

/**
 * Best-effort port detection from a shell command. Honors an explicit
 * `--port N` / `-p N`, a `:N` host-port token, then falls back to a known
 * framework default. Returns null when no server is implied.
 */
export function detectServerFromCommand(command: string): DetectedServer | null {
  const explicit = command.match(/--?port\s+(\d{2,5})/) ?? command.match(/-p\s+(\d{2,5})/);
  if (explicit) return { port: Number(explicit[1]) };

  const colon = command.match(/:(\d{2,5})(?=[\s"'$]|$)/);
  if (colon) return { port: Number(colon[1]) };

  const lower = command.toLowerCase();
  for (const [fw, port] of Object.entries(FRAMEWORK_DEFAULT_PORT)) {
    if (lower.includes(fw)) return { port, framework: fw };
  }
  // A generic dev script most often means a Vite dev server.
  if (lower.includes("dev")) return { port: 5173, framework: "vite" };
  return null;
}
