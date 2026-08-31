import { describe, expect, it } from "vitest";
import { profileForModel, modelSupportsImages, PROFILE_BY_ID, profileToFrameProfile } from "./model-profiles";
import { renderFrames } from "./renderer";

describe("snapcompact model profiles", () => {
  it("selects the OpenAI profile for gpt-4o", () => {
    expect(profileForModel({ provider: "openai", id: "gpt-4o" }).id).toBe("openai-gpt-4o");
  });
  it("selects the OpenAI profile for codex/o4 identifiers", () => {
    expect(profileForModel({ id: "o4-mini" }).id).toBe("openai-gpt-4o");
    expect(profileForModel({ id: "codex-1" }).id).toBe("openai-gpt-4o");
  });
  it("selects the Anthropic profile for claude", () => {
    expect(profileForModel({ provider: "anthropic", id: "claude-3.5-sonnet" }).id).toBe("anthropic-claude");
  });
  it("falls back to generic for unknown providers", () => {
    expect(profileForModel({ provider: "mystery", id: "x-1" }).id).toBe("generic-vision");
    expect(profileForModel(null).id).toBe("generic-vision");
  });
  it("exposes every profile by id", () => {
    for (const p of Object.values(PROFILE_BY_ID)) {
      expect(PROFILE_BY_ID[p.id]).toBe(p);
    }
  });
  it("profileToFrameProfile yields a renderer-compatible profile", () => {
    const p = profileToFrameProfile(profileForModel({ provider: "openai", id: "gpt-4o" }));
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
    expect(p.maxFrames).toBeGreaterThan(0);
    // It must actually drive a non-empty render.
    const r = renderFrames({ sourceText: "hello", rawSymbols: [], profile: p });
    expect(r.frames.length).toBeGreaterThan(0);
  });
});

describe("snapcompact vision capability detection", () => {
  it("returns true when input includes image", () => {
    expect(modelSupportsImages({ input: ["text", "image"] })).toBe(true);
  });
  it("returns false when input omits image", () => {
    expect(modelSupportsImages({ input: ["text"] })).toBe(false);
    expect(modelSupportsImages({})).toBe(false);
    expect(modelSupportsImages(null)).toBe(false);
  });
});
