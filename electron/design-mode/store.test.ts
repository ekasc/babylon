import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendDesignLog,
  briefPathFor,
  createDesignState,
  designDir,
  designFileForSession,
  loadDesignState,
  parseDesignTarget,
  sanitizedStateFor,
  saveDesignState,
  slugFor,
  stageFor,
  stageOfState,
  unwrapDesignResult,
} from "./store";

const SESSION = "01HXZ5Y3K8PQRS6T7UVWX9YZ12";

describe("design stage derivation", () => {
  const base = createDesignState("Us screen", "us-screen");
  it("elicits with no state, confirms with an unapproved brief", () => {
    expect(stageFor(null, false, false)).toBe("idle");
    expect(stageFor(base, false, false)).toBe("elicit");
    expect(stageFor(base, true, false)).toBe("brief-confirm");
  });
  it("gates build on both approvals", () => {
    expect(stageFor({ ...base, briefApproved: true }, true, false)).toBe("brand");
    expect(stageFor({ ...base, briefApproved: true }, true, true)).toBe("brand");
    expect(stageFor({ ...base, briefApproved: true, brandApproved: true }, true, true)).toBe("build");
  });
  it("ends when done", () => {
    expect(stageFor({ ...base, done: true }, true, true)).toBe("done");
  });
});

describe("design state round-trip", () => {
  it("fails closed on a hostile session id", () => {
    expect(() => designFileForSession("/tmp/x", "../evil")).toThrow("invalid session id");
  });
  it("saves, loads, and misses cleanly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pideck-design-"));
    expect(await loadDesignState(cwd, SESSION)).toBeNull();
    const state = createDesignState("Us screen", "us-screen");
    await saveDesignState(cwd, SESSION, state);
    expect(await loadDesignState(cwd, SESSION)).toMatchObject({ slug: "us-screen" });
    expect(briefPathFor("us-screen")).toContain("us-screen-brief.md");
  });
  it("lapses approvals when artifacts go missing", () => {
    const approved = { ...createDesignState("Us screen", "us-screen"), briefApproved: true, brandApproved: true };
    expect(sanitizedStateFor(approved, true, true)).toBe(approved);
    expect(sanitizedStateFor(approved, true, false)).toMatchObject({ briefApproved: true, brandApproved: false });
    expect(sanitizedStateFor(approved, false, true)).toMatchObject({ briefApproved: false, brandApproved: false });
  });
  it("never yields an empty slug", () => {
    expect(slugFor("Us screen")).toBe("us-screen");
    const fallback = slugFor("!!!");
    expect(fallback).toMatch(/^untitled-[a-f0-9]{8}$/);
    expect(slugFor("!!!")).not.toBe(slugFor("???"));
  });
  it("rejects hand-edited artifact paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pideck-design-"));
    const state = createDesignState("Us screen", "us-screen");
    await saveDesignState(cwd, SESSION, { ...state, logPath: "../../evil.md" });
    expect(await loadDesignState(cwd, SESSION)).toBeNull();
  });
  it("prepends log entries newest-first", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pideck-design-"));
    const state = createDesignState("Us screen", "us-screen");
    await appendDesignLog(cwd, state, "round 1: pass");
    await appendDesignLog(cwd, state, "round 2: fail, fix spacing");
    const raw = await readFile(join(cwd, state.logPath), "utf-8");
    expect(raw.indexOf("round 2")).toBeLessThan(raw.indexOf("round 1"));
  });
});

describe("design stage against the worktree", () => {
  it("derives the live stage from artifact files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pideck-design-"));
    expect(stageOfState(cwd, null)).toBe("idle");
    const state = createDesignState("Us screen", "us-screen");
    expect(stageOfState(cwd, state)).toBe("elicit");
    await mkdir(designDir(cwd), { recursive: true });
    await writeFile(join(cwd, state.briefPath), "# brief\n", "utf-8");
    expect(stageOfState(cwd, state)).toBe("brief-confirm");
    const approved = { ...state, briefApproved: true, brandApproved: true };
    await writeFile(join(cwd, state.brandPath), "# brand\n", "utf-8");
    expect(stageOfState(cwd, approved)).toBe("build");
  });
});

describe("unwrapDesignResult", () => {
  it("passes state plus stage through, null when no session", () => {
    const state = createDesignState("Us screen", "us-screen");
    expect(unwrapDesignResult({ design: state, stage: "brand" }, "t")).toEqual({ design: state, stage: "brand" });
    expect(unwrapDesignResult({ design: null, stage: "idle" }, "t")).toEqual({ design: null, stage: "idle" });
  });
  it("fails closed on malformed payloads", () => {
    expect(() => unwrapDesignResult(null, "t")).toThrow("malformed payload");
    expect(() => unwrapDesignResult({ design: { slug: 1 }, stage: "brand" }, "t")).toThrow("malformed payload");
  });
});

describe("design target", () => {
  it("parses only the known targets", () => {
    expect(parseDesignTarget("web")).toBe("web");
    expect(parseDesignTarget("mobile-web")).toBe("mobile-web");
    expect(parseDesignTarget("native")).toBe("native");
    expect(parseDesignTarget("desktop")).toBeNull();
    expect(parseDesignTarget(undefined)).toBeNull();
    expect(parseDesignTarget(42)).toBeNull();
  });
  it("defaults new sessions to web and round-trips a recorded target", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pideck-design-"));
    expect(createDesignState("Us screen", "us-screen").target).toBe("web");
    await saveDesignState(cwd, SESSION, { ...createDesignState("Us screen", "us-screen"), target: "native" });
    expect((await loadDesignState(cwd, SESSION))?.target).toBe("native");
  });
  it("reads sessions written before the target field as web", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pideck-design-"));
    const state = createDesignState("Us screen", "us-screen");
    await saveDesignState(cwd, SESSION, state);
    const path = designFileForSession(cwd, SESSION);
    const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    delete raw.target;
    await writeFile(path, JSON.stringify(raw), "utf-8");
    expect((await loadDesignState(cwd, SESSION))?.target).toBe("web");
  });
});
