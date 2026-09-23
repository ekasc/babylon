/** Human message for a caught throw: Error messages and thrown strings pass
 *  through, everything else degrades to the caller-supplied fallback. */
export function errorMessage(thrown: unknown, fallback: string): string {
  if (thrown instanceof Error && thrown.message) return thrown.message;
  if (typeof thrown === "string" && thrown) return thrown;
  return fallback;
}

/** Stable wire text for a missing transcript. Errors cross the daemon socket
 *  and Electron IPC as message-only serializations, so this exact string is
 *  part of the contract — change it only alongside isSessionNotFound. */
export const SESSION_NOT_FOUND_MESSAGE = "session path does not exist";

/** Thrown when a transcript path is well-formed but not on disk. Carries a
 *  machine-readable code for in-process checks; use isSessionNotFound at
 *  every site instead of matching prose. */
export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND";
  constructor(path?: string) {
    super(path ? `${SESSION_NOT_FOUND_MESSAGE}: ${path}` : SESSION_NOT_FOUND_MESSAGE);
    this.name = "SessionNotFoundError";
  }
}

/** True for a missing-transcript failure, however it arrives: the class
 *  itself (same process), a code-carrying serialization, or the exact
 *  stable message (boundaries that strip everything but the message).
 *  Prefix-accepts so the path-annotated form matches too. */
export function isSessionNotFound(err: unknown): boolean {
  if (err instanceof SessionNotFoundError) return true;
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "SESSION_NOT_FOUND") {
    return true;
  }
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : null;
  return message != null && (message === SESSION_NOT_FOUND_MESSAGE || message.startsWith(`${SESSION_NOT_FOUND_MESSAGE}:`));
}
