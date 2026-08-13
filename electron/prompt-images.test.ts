import { describe, expect, it } from "vitest";
import { toPiImages } from "./prompt-images";

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
