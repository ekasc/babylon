import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contained } from "../session-path";
import { designDir, type DesignState } from "./store";

/** The two artifacts a human approves. Semantic by design: the renderer never
 *  gets a generic file reader, only the two documents this flow owns. */
export type DesignArtifactKind = "brief" | "direction";

export interface DesignArtifact {
  kind: DesignArtifactKind;
  content: string;
  /** Content hash of what the user actually read. Approval is bound to it. */
  revision: string;
}

export class DesignArtifactChangedError extends Error {
  constructor(kind: DesignArtifactKind) {
    super(
      `The ${kind} changed since you opened it. Review the latest version before approving.`
    );
    this.name = "DesignArtifactChangedError";
  }
}

export function isDesignArtifactKind(value: unknown): value is DesignArtifactKind {
  return value === "brief" || value === "direction";
}

function artifactPath(state: DesignState, kind: DesignArtifactKind): string {
  return kind === "brief" ? state.briefPath : state.directionPath;
}

export function revisionFor(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Read one artifact, with the revision the user is about to approve.
 *
 *  The path comes from the TRUSTED state and is still containment-checked
 *  against the design directory: a hand-edited state file must not be able to
 *  turn this into an arbitrary file read. */
export async function readDesignArtifact(cwd: string, state: DesignState, kind: DesignArtifactKind): Promise<DesignArtifact> {
  const rel = artifactPath(state, kind);
  if (!contained(designDir(cwd), resolve(cwd, rel))) {
    throw new Error("design artifact is outside the design directory");
  }
  const content = await readFile(resolve(cwd, rel), "utf-8");
  return { kind, content, revision: revisionFor(content) };
}

/** Approve exactly the revision the human read.
 *
 *  This is the point of a review surface: the file may have been rewritten
 *  between opening it and clicking approve, and approving the NEW text the user
 *  never read is exactly the bug this guards. */
export async function approveDesignArtifact(
  cwd: string,
  state: DesignState,
  kind: DesignArtifactKind,
  revision: string
): Promise<DesignArtifact> {
  const current = await readDesignArtifact(cwd, state, kind);
  if (current.revision !== revision) throw new DesignArtifactChangedError(kind);
  return current;
}

export function approvedFlagFor(kind: DesignArtifactKind): "briefApproved" | "directionApproved" {
  return kind === "brief" ? "briefApproved" : "directionApproved";
}
