import { describe, expect, it } from "vitest";
import { shouldRelayImagesThrough, toPiImages } from "./prompt-images";

describe("toPiImages", () => {
  it("uses pi-ai's flat ImageContent shape", () => {
    expect(toPiImages([{ data: "abc", mimeType: "image/png" }])).toEqual([
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);
  });

  it("defaults the MIME type and omits an empty collection", () => {
    expect(toPiImages([{ data: "abc" }])).toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
    expect(toPiImages([])).toBeUndefined();
  });
});

describe("shouldRelayImagesThrough", () => {
  const IMAGE = { provider: "openai", modelId: "gpt-4o" };

  it("is false without an image model", () => {
    expect(shouldRelayImagesThrough(undefined, { input: ["text"] })).toBe(false);
  });

  it("keeps raw images when the chat model has vision", () => {
    expect(shouldRelayImagesThrough(IMAGE, { input: ["text", "image"] })).toBe(false);
    expect(shouldRelayImagesThrough(IMAGE, { input: ["image"] })).toBe(false);
    expect(shouldRelayImagesThrough(IMAGE, { supportsImages: true })).toBe(false);
    expect(shouldRelayImagesThrough(IMAGE, { vision: true })).toBe(false);
  });

  it("relays through the image model when the chat model has no vision", () => {
    expect(shouldRelayImagesThrough(IMAGE, { input: ["text"] })).toBe(true);
    expect(shouldRelayImagesThrough(IMAGE, null)).toBe(true);
    expect(shouldRelayImagesThrough(IMAGE, {})).toBe(true);
  });
});
