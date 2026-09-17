import { describe, expect, it } from "vitest";
import {
  LOGIN_ENV_MARKER,
  applyShellEnv,
  importLoginShellEnv,
  mergePath,
  parseShellEnv,
  readLoginShellEnv,
} from "./shell-env";

describe("login shell environment", () => {
  it("prefers login entries and drops duplicates", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("ignores empty segments", () => {
    expect(mergePath(":/opt/homebrew/bin::", ":")).toBe("/opt/homebrew/bin");
  });

  it("keeps the inherited PATH when the login PATH is empty", () => {
    expect(mergePath("", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  });

  it("parses env -0 output after the marker, tolerating a banner", () => {
    const stdout = `motd line\n${LOGIN_ENV_MARKER}FOO=bar\0PATH=/opt/homebrew/bin:/usr/bin\0`;
    expect(parseShellEnv(stdout)).toEqual({ FOO: "bar", PATH: "/opt/homebrew/bin:/usr/bin" });
  });

  it("keeps values containing '=' and newlines", () => {
    const stdout = `${LOGIN_ENV_MARKER}A=b=c\0MULTI=line1\nline2\0`;
    expect(parseShellEnv(stdout)).toEqual({ A: "b=c", MULTI: "line1\nline2" });
  });

  it("returns undefined when the marker or entries are missing", () => {
    expect(parseShellEnv("just banner")).toBeUndefined();
    expect(parseShellEnv(LOGIN_ENV_MARKER)).toBeUndefined();
  });

  it("applies shell variables but never protected ones", () => {
    const target: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      NODE_OPTIONS: "--max-old-space-size=4096",
      ELECTRON_RUN_AS_NODE: "1",
      BABYLON_SETTINGS_PATH: "/tmp/settings.json",
      PIDECK_SMOKE: "1",
    };
    applyShellEnv(target, {
      PATH: "/opt/homebrew/bin:/usr/bin",
      JAVA_HOME: "/opt/homebrew/opt/openjdk",
      NODE_OPTIONS: "--require /tmp/evil.js",
      ELECTRON_RUN_AS_NODE: "",
      BABYLON_SETTINGS_PATH: "/tmp/other.json",
      PIDECK_SMOKE: "",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    });

    expect(target.JAVA_HOME).toBe("/opt/homebrew/opt/openjdk");
    expect(target.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    // Protected: Electron's own child-process behaviour and app config.
    expect(target.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(target.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(target.BABYLON_SETTINGS_PATH).toBe("/tmp/settings.json");
    expect(target.PIDECK_SMOKE).toBe("1");
    expect(target.VITE_DEV_SERVER_URL).toBeUndefined();
  });

  it("reads an environment from a real shell", async () => {
    const env = await readLoginShellEnv("/bin/sh");
    expect(env?.PATH).toContain("/bin");
  });

  it("returns undefined for a shell that does not exist", async () => {
    await expect(readLoginShellEnv("/nonexistent/shell-binary")).resolves.toBeUndefined();
  });

  it("sources a shell into process.env without duplicating PATH entries", async () => {
    const originalPath = process.env.PATH;
    try {
      await importLoginShellEnv();
      const entries = (process.env.PATH ?? "").split(":");
      expect(entries.length).toBeGreaterThan(4);
      expect(new Set(entries).size).toBe(entries.length);
      expect(process.env.PATH).toContain("/bin");
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);
});
