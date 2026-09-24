/**
 * Attachment policy for the composer (T3's caps, adapted to base64-inline).
 *
 * Limits mirror T3's provider send-turn contract so oversized sends fail in
 * the composer with a message instead of downstream as provider errors.
 */

/** Max files per message (T3 PROVIDER_SEND_TURN_MAX_ATTACHMENTS). */
export const MAX_SEND_ATTACHMENTS = 8;
/** Max characters per send after file blocks are inlined (T3 _MAX_INPUT_CHARS). */
export const MAX_SEND_INPUT_CHARS = 120_000;
/** Pasted text at or above this byte size becomes a file attachment (T3's
 *  32KB rule; byte-based so CJK clipboard contents aren't undercounted). */
export const PASTED_TEXT_THRESHOLD_BYTES = 32 * 1024;
/** Per-file size cap (applies to images and files alike). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const textEncoder = new TextEncoder();

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const HEIC_MIME = /^image\/hei(?:c|f)$/i;
const HEIC_EXTENSION = /\.(?:heic|heif)$/i;

/**
 * Infer an image MIME type from the file name for typeless drags (other
 * apps and shells often hand over Files with empty or generic types).
 * Returns null when the file already carries a usable type or the
 * extension isn't a readable image.
 */
export function inferImageMimeTypeFromName(name: string, type: string): string | null {
  if (type && type !== "application/octet-stream") return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return IMAGE_MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** True for HEIC/HEIF by type or extension. No decoder ships yet, so these
 *  are rejected with guidance instead of silently riding through unread. */
export function isHeicFile(name: string, type: string): boolean {
  return HEIC_MIME.test(type) || HEIC_EXTENSION.test(name);
}

/** Effective MIME for routing: declared type, else inferred image type, else
 *  generic octet-stream. */
export function effectiveFileMimeType(name: string, type: string): string {
  if (type && type !== "application/octet-stream") return type;
  return inferImageMimeTypeFromName(name, type) ?? "application/octet-stream";
}

/** Byte length of text (CJK-aware, unlike String.length). */
export function textByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/** True when pasted text should become a file attachment instead of inline. */
export function shouldAttachPastedText(text: string): boolean {
  return text.length > 0 && textByteLength(text) >= PASTED_TEXT_THRESHOLD_BYTES;
}

/** Stable, human-readable names when several pastes fold to files. */
export function nextPastedTextName(existingNames: ReadonlyArray<string>): string {
  const names = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!names.has("pasted-text.txt")) return "pasted-text.txt";
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) return candidate;
  }
}

/** Paste-as-text shortcut on keydown (mod+Shift+V): arms a short window
 *  during which the paste handler skips attachment conversion and lets the
 *  text land inline. A flag (not event state) because clipboard events
 *  carry no modifier keys. */
export function isPasteAsTextShortcutKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.key.toLowerCase() === "v" && e.shiftKey && !e.altKey && (e.metaKey !== e.ctrlKey);
}

/** How long the paste-as-text arming lasts after the shortcut. */
export const PASTE_AS_TEXT_ARM_MS = 1000;
