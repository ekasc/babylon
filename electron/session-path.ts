import { promises as fsp } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Canonicalize an existing transcript and reject symlinks escaping the session store. */
export async function validateSessionPath(root: string, path: unknown): Promise<string> {
  if (typeof path !== "string" || !path.endsWith(".jsonl")) throw new Error("invalid session path");
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    fsp.realpath(resolve(root)),
    fsp.realpath(resolve(path)),
  ]).catch(() => {
    throw new Error("session path does not exist");
  });
  if (!contained(canonicalRoot, canonicalTarget)) {
    throw new Error("session path is outside the pi sessions directory");
  }
  return canonicalTarget;
}
