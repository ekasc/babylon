/** Human message for a caught throw: Error messages and thrown strings pass
 *  through, everything else degrades to the caller-supplied fallback. */
export function errorMessage(thrown: unknown, fallback: string): string {
  if (thrown instanceof Error && thrown.message) return thrown.message;
  if (typeof thrown === "string" && thrown) return thrown;
  return fallback;
}
