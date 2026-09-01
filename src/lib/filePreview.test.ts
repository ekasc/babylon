import { describe, expect, it } from "vitest";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
} from "./filePreview";

describe("filePreview", () => {
  it("detects browser preview", () => {
    expect(isWorkspaceBrowserPreviewPath("index.html")).toBe(true);
    expect(isWorkspaceBrowserPreviewPath("doc.htm")).toBe(true);
    expect(isWorkspaceBrowserPreviewPath("file.pdf")).toBe(true);
    expect(isWorkspaceBrowserPreviewPath("image.png")).toBe(false);
  });

  it("is case-insensitive and strips query", () => {
    expect(isWorkspaceBrowserPreviewPath("INDEX.HTML?foo=1")).toBe(true);
    expect(isWorkspaceBrowserPreviewPath("page.HTM#hash")).toBe(true);
  });

  it("detects image preview", () => {
    expect(isWorkspaceImagePreviewPath("photo.jpg")).toBe(true);
    expect(isWorkspaceImagePreviewPath("icon.SVG")).toBe(true);
    expect(isWorkspaceImagePreviewPath("doc.pdf")).toBe(false);
  });

  it("detects any preview entry", () => {
    expect(isWorkspacePreviewEntryPath("a.html")).toBe(true);
    expect(isWorkspacePreviewEntryPath("b.png")).toBe(true);
    expect(isWorkspacePreviewEntryPath("c.txt")).toBe(false);
  });
});
