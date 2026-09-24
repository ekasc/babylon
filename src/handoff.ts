// Shared handoff shape (renderer-safe; the store lives main-side).
// A default-agent-authored summary of a read-only past thread.
export interface Handoff {
  id: string;
  sourceFile: string;
  summary: string;
  /** Project default-bot name at authoring time (voice attribution). */
  author: string;
  at: string;
  sourceChars: number;
  consumedInto: Array<{ file: string; at: string }>;
}
