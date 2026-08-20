import { describe, expect, it } from "vitest";
import { isTrustedRendererUrl } from "./navigation";

describe("renderer navigation trust", () => {
  const productionUrl = "file:///Applications/Babylon/resources/app/dist/index.html";

  it("trusts only the bundled production entry", () => {
    expect(isTrustedRendererUrl(productionUrl, undefined, productionUrl)).toBe(true);
    expect(isTrustedRendererUrl("file:///tmp/attacker.html", undefined, productionUrl)).toBe(false);
  });

  it("trusts the configured development origin", () => {
    const devUrl = "http://127.0.0.1:5173";
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/src/main.tsx", devUrl, productionUrl)).toBe(true);
    expect(isTrustedRendererUrl("http://127.0.0.1:51730/", devUrl, productionUrl)).toBe(false);
  });
});
