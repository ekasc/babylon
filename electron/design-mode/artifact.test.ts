import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveDesignArtifact,
  DesignArtifactChangedError,
  readDesignArtifact,
  revisionFor,
} from "./artifact";
import { createDesignState, designFileForSession, loadDesignState, saveDesignState } from "./store";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))));

const SESSION_ID = "019ff998-0000-4000-8000-0000000000aa";

async function makeProject(tag: string) {
  const cwd = await mkdtemp(join(tmpdir(), `pideck-artifact-${tag}-`));
  roots.push(cwd);
  return cwd;
}

async function writeArtifacts(cwd: string, state: ReturnType<typeof createDesignState>, brief = "# Brief\n- goal\n") {
  await mkdir(join(cwd, ".babylon", "design"), { recursive: true });
  await writeFile(join(cwd, state.briefPath), brief, "utf-8");
  await writeFile(join(cwd, state.directionPath), "# Design direction\n", "utf-8");
}

describe("design artifacts", () => {
  it("reads the artifact the user is approving, with its revision", async () => {
    const cwd = await makeProject("read");
    const state = createDesignState("Us screen", "us-screen");
    await writeArtifacts(cwd, state, "# Brief\n- browser-like tabs\n");

    const artifact = await readDesignArtifact(cwd, state, "brief");
    expect(artifact.kind).toBe("brief");
    expect(artifact.content).toContain("browser-like tabs");
    expect(artifact.revision).toBe(revisionFor("# Brief\n- browser-like tabs\n"));
  });

  it("approves exactly the revision that was read", async () => {
    const cwd = await makeProject("approve");
    const state = createDesignState("Us screen", "us-screen");
    await writeArtifacts(cwd, state);
    const read = await readDesignArtifact(cwd, state, "brief");
    await expect(approveDesignArtifact(cwd, state, "brief", read.revision)).resolves.toMatchObject({ kind: "brief" });
  });

  it("refuses an approval bound to a revision that is no longer current", async () => {
    const cwd = await makeProject("stale");
    const state = createDesignState("Us screen", "us-screen");
    await writeArtifacts(cwd, state, "# Brief\n- original\n");
    const read = await readDesignArtifact(cwd, state, "brief");

    // The agent rewrites the brief while the review surface is open.
    await writeFile(join(cwd, state.briefPath), "# Brief\n- rewritten by the agent\n", "utf-8");

    // The user clicked approve on text they never saw: refuse.
    await expect(approveDesignArtifact(cwd, state, "brief", read.revision)).rejects.toBeInstanceOf(
      DesignArtifactChangedError
    );
    await expect(approveDesignArtifact(cwd, state, "brief", read.revision)).rejects.toThrow(/changed since you opened it/);
  });

  it("accepts a fresh read of the rewritten artifact", async () => {
    const cwd = await makeProject("reread");
    const state = createDesignState("Us screen", "us-screen");
    await writeArtifacts(cwd, state, "# Brief\n- original\n");
    await writeFile(join(cwd, state.briefPath), "# Brief\n- rewritten\n", "utf-8");
    const fresh = await readDesignArtifact(cwd, state, "brief");
    await expect(approveDesignArtifact(cwd, state, "brief", fresh.revision)).resolves.toBeTruthy();
  });

  it("refuses to read outside the design directory", async () => {
    const cwd = await makeProject("escape");
    const state = createDesignState("Us screen", "us-screen");
    await mkdir(join(cwd, ".babylon", "design"), { recursive: true });
    // A hand-edited state must not turn this into an arbitrary file read.
    const escaped = { ...state, briefPath: "../../../etc/passwd" };
    await expect(readDesignArtifact(cwd, escaped, "brief")).rejects.toThrow(/outside the design directory/);
  });
});

describe("one-way migration of persisted design state", () => {
  const legacyState = (slug: string) => ({
    slug,
    subject: "Us screen",
    target: "web",
    briefPath: join(".babylon", "design", `${slug}-brief.md`),
    brandPath: join(".babylon", "design", `${slug}-brand.md`),
    logPath: join(".babylon", "design", `${slug}-log.md`),
    briefApproved: true,
    brandApproved: true,
    done: false,
    updatedAt: "2026-09-01T00:00:00.000Z",
  });

  it("1. a legacy brandPath/brandApproved state loads in the new shape", async () => {
    const cwd = await makeProject("legacy-load");
    await mkdir(join(cwd, ".babylon", "design", "sessions"), { recursive: true });
    const legacy = legacyState("us-screen");
    await writeFile(designFileForSession(cwd, SESSION_ID), JSON.stringify(legacy), "utf-8");
    await writeFile(join(cwd, legacy.brandPath), "# direction\n", "utf-8");

    const loaded = await loadDesignState(cwd, SESSION_ID);
    expect(loaded).not.toBeNull();
    expect(loaded?.directionPath).toBe(legacy.brandPath);
    expect(loaded?.directionApproved).toBe(true);
    // The returned shape carries the new names only.
    expect(loaded).not.toHaveProperty("brandPath");
    expect(loaded).not.toHaveProperty("brandApproved");
  });

  it("2. after any subsequent save the file contains no brand* fields", async () => {
    const cwd = await makeProject("legacy-resave");
    await mkdir(join(cwd, ".babylon", "design", "sessions"), { recursive: true });
    await writeFile(designFileForSession(cwd, SESSION_ID), JSON.stringify(legacyState("us-screen")), "utf-8");

    const loaded = await loadDesignState(cwd, SESSION_ID);
    expect(loaded).not.toBeNull();
    await saveDesignState(cwd, SESSION_ID, loaded!);

    const raw = JSON.parse(await readFile(designFileForSession(cwd, SESSION_ID), "utf-8")) as Record<string, unknown>;
    // No legacy key survives, whatever the state looked like on the way in.
    expect(Object.keys(raw).filter((key) => key.toLowerCase().includes("brand"))).toEqual([]);
    expect(raw.directionPath).toBeTruthy();
    expect(raw.directionApproved).toBe(true);
  });

  it("3. a mixed state prefers direction*, so a stale legacy value cannot win", async () => {
    const cwd = await makeProject("mixed");
    await mkdir(join(cwd, ".babylon", "design", "sessions"), { recursive: true });
    const fresh = createDesignState("Us screen", "us-screen");
    const mixed = {
      ...fresh,
      directionApproved: false,
      // Stale leftovers from an older writer.
      brandPath: fresh.directionPath,
      brandApproved: true,
    };
    await writeFile(designFileForSession(cwd, SESSION_ID), JSON.stringify(mixed), "utf-8");

    const loaded = await loadDesignState(cwd, SESSION_ID);
    expect(loaded?.directionApproved).toBe(false);
    expect(loaded?.directionPath).toBe(fresh.directionPath);
  });
});
