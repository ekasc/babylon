import { describe, expect, it } from "vitest";
import {
  MAX_SEND_ATTACHMENTS,
  MAX_SEND_INPUT_CHARS,
  PASTED_TEXT_THRESHOLD_BYTES,
  effectiveFileMimeType,
  inferImageMimeTypeFromName,
  isHeicFile,
  isPasteAsTextShortcutKey,
  nextPastedTextName,
  shouldAttachPastedText,
  textByteLength,
} from "./attachments";

describe("attachment policy", () => {
  it("mirrors T3's send-turn contract numbers", () => {
    expect(MAX_SEND_ATTACHMENTS).toBe(8);
    expect(MAX_SEND_INPUT_CHARS).toBe(120_000);
    expect(PASTED_TEXT_THRESHOLD_BYTES).toBe(32 * 1024);
  });

  it("infers image MIME for typeless drags only", () => {
    expect(inferImageMimeTypeFromName("photo.jpg", "")).toBe("image/jpeg");
    expect(inferImageMimeTypeFromName("photo.PNG", "application/octet-stream")).toBe("image/png");
    expect(inferImageMimeTypeFromName("photo.jpg", "image/jpeg")).toBeNull();
    expect(inferImageMimeTypeFromName("notes.txt", "")).toBeNull();
    expect(inferImageMimeTypeFromName("Makefile", "")).toBeNull();
  });

  it("detects HEIC by type or extension", () => {
    expect(isHeicFile("photo.heic", "")).toBe(true);
    expect(isHeicFile("photo.HEIF", "")).toBe(true);
    expect(isHeicFile("photo", "image/heic")).toBe(true);
    expect(isHeicFile("photo.jpg", "")).toBe(false);
    expect(isHeicFile("photo.jpg", "image/jpeg")).toBe(false);
  });

  it("resolves the effective routing MIME", () => {
    expect(effectiveFileMimeType("a.jpg", "image/jpeg")).toBe("image/jpeg");
    expect(effectiveFileMimeType("a.jpg", "")).toBe("image/jpeg");
    expect(effectiveFileMimeType("a.txt", "")).toBe("application/octet-stream");
  });

  it("measures bytes, not chars", () => {
    expect(textByteLength("abc")).toBe(3);
    expect(textByteLength("あ")).toBe(3);
  });

  it("folds large pastes to files on bytes", () => {
    expect(shouldAttachPastedText("")).toBe(false);
    expect(shouldAttachPastedText("small")).toBe(false);
    expect(shouldAttachPastedText("あ".repeat(2000))).toBe(false);
    expect(shouldAttachPastedText("x".repeat(32 * 1024))).toBe(true);
  });

  it("names pasted files stably", () => {
    expect(nextPastedTextName([])).toBe("pasted-text.txt");
    expect(nextPastedTextName(["pasted-text.txt"])).toBe("pasted-text-2.txt");
    expect(nextPastedTextName(["PASTED-TEXT.TXT", "pasted-text-2.txt"])).toBe("pasted-text-3.txt");
  });

  it("arms paste-as-text on mod+Shift+V only", () => {
    const base = { key: "v", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPasteAsTextShortcutKey({ ...base, metaKey: true, shiftKey: true })).toBe(true);
    expect(isPasteAsTextShortcutKey({ ...base, ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isPasteAsTextShortcutKey({ ...base, metaKey: true, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPasteAsTextShortcutKey({ ...base, metaKey: true, shiftKey: true, altKey: true })).toBe(false);
    expect(isPasteAsTextShortcutKey({ ...base, metaKey: true })).toBe(false);
    expect(isPasteAsTextShortcutKey({ ...base, key: "x", metaKey: true, shiftKey: true })).toBe(false);
  });
});
