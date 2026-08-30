// Context assembly for snapcompact.
//
// Produces the per-prompt projection that Babylon's prompt pipeline
// attaches to a user message:
//
//   - images:            the archive's PNG frames, in chronological order
//   - dictionaryText:    the raw exact-token dictionary
//   - headerText:        a structured text block prepended to the user
//                         message containing the archive's head / tail
//                         text and the dictionary (so the model has raw
//                         text anchors near the images)
//   - prepend:           headerText formatted for the renderer
//
// The session's own transcript (recent verbatim) is held by Pi and is
// not duplicated here. The projection is a non-destructive addition.

import type { SnapcompactArchive } from "./types";

const HEADER_BOUNDARY_CHARS = 600;

function trimToLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(0, maxChars - 80));
  return cut + "\n\u2026 [boundary text truncated for header]";
}

function formatSymbols(symbols: SnapcompactArchive["symbols"]): string {
  if (!symbols.length) return "(no symbols)";
  return symbols.map((s) => `${s.id}=${s.value}`).join("; ");
}

export interface ContextProjection {
  images: Array<{ type: "image"; data: Buffer; mimeType: "image/png" }>;
  headerText: string;
  /** True if snapcompact is supplying context (false = caller falls back). */
  usedSnapcompact: boolean;
}

export function buildContextProjection(archive: SnapcompactArchive): ContextProjection {
  const head = trimToLines(archive.sourceText, HEADER_BOUNDARY_CHARS);
  const tail = trimToLines(
    archive.sourceText.length > HEADER_BOUNDARY_CHARS
      ? archive.sourceText.slice(Math.max(0, archive.sourceText.length - HEADER_BOUNDARY_CHARS))
      : "",
    HEADER_BOUNDARY_CHARS
  );
  const symbolLine = formatSymbols(archive.symbols);
  const headerText =
    `[Snapcompact archive] sessionId=${archive.sessionId} profile=${archive.profileId} ` +
    `frames=${archive.frames.length} bytes=${archive.frameBytes}\n` +
    `--- archive head ---\n${head}\n` +
    `--- archive tail ---\n${tail || "(empty)"}\n` +
    `--- symbol dictionary ---\n${symbolLine}\n` +
    `--- end snapcompact ---\n`;
  const images = archive.frames.map((f) => ({ type: "image" as const, data: f.png, mimeType: "image/png" as const }));
  return { images, headerText, usedSnapcompact: true };
}

/** Build the final user-facing message by prepending the snapcompact
 *  header. The recent raw conversation lives in the Pi session and is
 *  not part of this projection. */
export function assembleUserMessage(originalUserMessage: string, projection: ContextProjection): string {
  if (!projection.usedSnapcompact) return originalUserMessage;
  return projection.headerText + "\n" + originalUserMessage;
}
