import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSettings, saveSettings } from "./app-settings";

describe("app settings image model", () => {
  it("persists and clears the image model ref", () => {
    process.env.BABYLON_SETTINGS_PATH = join(
      mkdtempSync(join(tmpdir(), "babylon-settings-")),
      "pideck-settings.json"
    );

    saveSettings({ imageModel: { provider: "openai", modelId: "gpt-4o" } });
    expect(getSettings().imageModel).toEqual({ provider: "openai", modelId: "gpt-4o" });

    saveSettings({ imageModel: undefined });
    expect(getSettings().imageModel).toBeUndefined();
  });
});