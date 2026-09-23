/**
 * Prompt-target resolution for sends (see App send()).
 *
 * The target must resolve from the live active-path ref AFTER the session
 * warmup wait — never from the render closure's activeSessionPath /
 * status.sessionPath, which may still point at the previous session
 * (A → New Session → send before ready would otherwise deterministically
 * target A once explicit session routing exists). The epoch guard rejects
 * the send when a newer switch started while waiting.
 */
export function resolveSendTarget(
  sendEpoch: number,
  epochNow: number,
  activePath: string | null,
): string {
  if (sendEpoch !== epochNow) {
    throw new Error("session changed before the message could be sent");
  }
  if (!activePath) throw new Error("session is not ready");
  return activePath;
}
