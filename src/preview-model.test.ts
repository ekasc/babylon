import { describe, expect, it } from "vitest";
import {
  detectServerFromCommand,
  inferFramework,
} from "./preview-model";

describe("inferFramework", () => {
  it("labels framework commands and ignores lookalikes", () => {
    expect(inferFramework("vite --port 4173")).toBe("vite");
    expect(inferFramework("next dev")).toBe("next");
    expect(inferFramework("pnpm dev")).toBeUndefined();
    expect(inferFramework("git checkout next")).toBeUndefined();
    expect(inferFramework("ls -la")).toBeUndefined();
  });
});

describe("detectServerFromCommand", () => {
  it("honors an explicit --port (space or = form)", () => {
    expect(detectServerFromCommand("vite --port 4173")).toEqual({ port: 4173, framework: "vite" });
    expect(detectServerFromCommand("vite --port=4173")).toEqual({ port: 4173, framework: "vite" });
    expect(detectServerFromCommand("next dev -p 4000")).toEqual({ port: 4000, framework: "next" });
  });

  it("honors a host:port token including urls and ipv4", () => {
    expect(detectServerFromCommand("webpack serve --host 0.0.0.0:9000")).toEqual({ port: 9000 });
    expect(detectServerFromCommand("curl http://localhost:3000/foo")).toEqual({ port: 3000 });
    expect(detectServerFromCommand("connect(127.0.0.1:3000)")).toEqual({ port: 3000 });
  });

  it("falls back to a known framework default", () => {
    expect(detectServerFromCommand("pnpm dev")).toEqual({ port: 5173, framework: "vite" });
    expect(detectServerFromCommand("next dev")).toEqual({ port: 3000, framework: "next" });
  });

  it("returns null when no server is implied", () => {
    expect(detectServerFromCommand("git commit -m wip")).toBeNull();
    expect(detectServerFromCommand("ls -la")).toBeNull();
    // /dev/ paths, timestamps, and unrelated -p flags must not false-positive.
    expect(detectServerFromCommand("ls /dev/null")).toBeNull();
    expect(detectServerFromCommand("git checkout next")).toBeNull();
    expect(detectServerFromCommand("echo deploy at 12:34")).toBeNull();
    expect(detectServerFromCommand("ssh -p 2222 example.com")).toBeNull();
    expect(detectServerFromCommand("cp -p 0644 file")).toBeNull();
  });
});
