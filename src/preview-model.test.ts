import { describe, expect, it } from "vitest";
import {
  createPreviewRegistry,
  detectServerFromCommand,
  listServers,
  registerServer,
  removeServer,
  updateServer,
  type PreviewRegistry,
} from "./preview-model";

describe("preview registry", () => {
  it("registers and lists a server with a localhost url", () => {
    const r = registerServer(createPreviewRegistry(), { id: "s1", port: 5173, framework: "vite" });
    expect(r.servers.s1).toMatchObject({ url: "http://localhost:5173", port: 5173, framework: "vite" });
    expect(listServers(r)).toHaveLength(1);
  });

  it("updates and removes immutably", () => {
    let r = registerServer(createPreviewRegistry(), { id: "s1", port: 3000 });
    r = updateServer(r, "s1", { state: "running" });
    expect(r.servers.s1.state).toBe("running");
    r = removeServer(r, "s1");
    expect(listServers(r)).toHaveLength(0);
  });
});

describe("detectServerFromCommand", () => {
  it("honors an explicit --port", () => {
    expect(detectServerFromCommand("vite --port 4173")).toEqual({ port: 4173 });
    expect(detectServerFromCommand("next dev -p 4000")).toEqual({ port: 4000 });
  });

  it("honors a host:port token", () => {
    expect(detectServerFromCommand("webpack serve --host 0.0.0.0:9000")).toEqual({ port: 9000 });
  });

  it("falls back to a known framework default", () => {
    expect(detectServerFromCommand("pnpm dev")).toEqual({ port: 5173, framework: "vite" });
    expect(detectServerFromCommand("next dev")).toEqual({ port: 3000, framework: "next" });
  });

  it("returns null when no server is implied", () => {
    expect(detectServerFromCommand("git commit -m wip")).toBeNull();
    expect(detectServerFromCommand("ls -la")).toBeNull();
  });
});
