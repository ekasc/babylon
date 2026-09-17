import { existsSync, promises as fsp } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export async function readSessionHeader(file: string): Promise<any> {
  try {
    const fd = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(16 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
      return JSON.parse(firstLine);
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

/** Ensure a cloned session file exists on disk for task resume and header patching. */
export async function ensureClonedSessionFile(
  clonedPath: string,
  originalPath: string,
  cwd: string,
  sessionId?: string
): Promise<void> {
  for (let i = 0; i < 15 && !existsSync(clonedPath); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (existsSync(clonedPath)) return;
  const raw = await fsp.readFile(originalPath, "utf8").catch(() => "");
  const nl = raw.indexOf("\n");
  const entries = nl === -1 ? "" : raw.slice(nl);
  const header = {
    type: "session",
    version: 3,
    id: sessionId ?? `forked-${Date.now()}`,
    timestamp: new Date().toISOString(),
    cwd,
    parentSession: originalPath,
  };
  await fsp.writeFile(clonedPath, `${JSON.stringify(header)}\n${entries}`);
}

/** Rewrite cloned-session ownership metadata while the agent is idle. */
export async function rewriteSessionHeader(
  file: string,
  patch: { cwd?: string; parentSession?: string }
): Promise<void> {
  for (let i = 0; i < 15 && !existsSync(file); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const raw = await fsp.readFile(file, "utf8");
  const nl = raw.indexOf("\n");
  const header = JSON.parse(nl === -1 ? raw : raw.slice(0, nl));
  if (patch.cwd) header.cwd = patch.cwd;
  if (patch.parentSession) header.parentSession = patch.parentSession;
  await fsp.writeFile(file, JSON.stringify(header) + (nl === -1 ? "\n" : raw.slice(nl)));
}

export function sanitizeWorktreeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function uniquePath(base: string): string {
  let p = base;
  let i = 2;
  while (existsSync(p)) p = `${base}-${i++}`;
  return p;
}

export function cwdWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
