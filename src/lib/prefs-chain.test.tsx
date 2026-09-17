// @vitest-environment jsdom
// Regression: the Appearance font-size rows must propagate live to their vars.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useStringPref, writeStringPref } from "./prefs";
import { clearStorageCache } from "./storage";
import { SettingsAppearance } from "../components/settings/SettingsAppearance";

vi.mock("../bridge", () => ({
  bridge: { listFonts: () => Promise.resolve([]) },
}));

/** Mirrors the font effect in App.tsx (message / prompt / code variables). */
function AppFontEffect() {
  const chatFont = useStringPref("chatFont", "14");
  const promptFont = useStringPref("promptFont", "14");
  const codeFont = useStringPref("codeFont", "13");
  useEffect(() => {
    const px = (v: string, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const root = document.documentElement.style;
    root.setProperty("--chat-font", `${px(chatFont, 14)}px`);
    root.setProperty("--prompt-font", `${px(promptFont, 14)}px`);
    root.setProperty("--code-font", `${px(codeFont, 13)}px`);
  }, [chatFont, promptFont, codeFont]);
  return null;
}

const getVar = (name: string) => document.documentElement.style.getPropertyValue(name);

describe("chat font pref chain", () => {
  it("the real Appearance rows drive their document vars live", () => {
    clearStorageCache();
    localStorage.clear();
    for (const v of ["--chat-font", "--prompt-font", "--code-font"]) {
      document.documentElement.style.removeProperty(v);
    }
    render(
      <>
        <AppFontEffect />
        <SettingsAppearance
          settings={null}
          onSave={() => undefined}
          theme="dark"
          onThemeChange={() => undefined}
          themeId="terminal"
          onThemeIdChange={() => undefined}
        />
      </>
    );
    const message = screen.getByLabelText("Message text") as HTMLInputElement;
    const prompt = screen.getByLabelText("Prompt text") as HTMLInputElement;
    const code = screen.getByLabelText("Code text") as HTMLInputElement;
    expect([message.value, prompt.value, code.value]).toEqual(["14", "14", "13"]);
    fireEvent.change(message, { target: { value: "20" } });
    fireEvent.change(prompt, { target: { value: "18" } });
    fireEvent.change(code, { target: { value: "16" } });
    expect([message.value, prompt.value, code.value]).toEqual(["20", "18", "16"]);
    expect(getVar("--chat-font")).toBe("20px");
    expect(getVar("--prompt-font")).toBe("18px");
    expect(getVar("--code-font")).toBe("16px");
  });
});
