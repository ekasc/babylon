import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiHost } from "./pi-host";
import type { AgentEvent } from "../src/bridge";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("PiHost resource and command integration", () => {
  it("loads extension commands, prompt templates, and skill commands and executes slash commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-host-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(agentDir, "skills", "demo-skill"), { recursive: true });
    await mkdir(join(agentDir, "prompts"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "hello.ts"),
      `export default function (pi) { pi.registerCommand("hello", { description: "hello test", handler: async (_args, ctx) => ctx.ui.notify("HELLO_FROM_EXTENSION", "info") }); }\n`
    );
    await writeFile(
      join(agentDir, "skills", "demo-skill", "SKILL.md"),
      `---\nname: demo-skill\ndescription: Demo skill for command discovery.\n---\n\n# Demo\n`
    );
    await writeFile(join(agentDir, "prompts", "review.md"), `---\ndescription: Review test\n---\nReview this.\n`);

    const events: AgentEvent[] = [];
    const host = new PiHost({ cwd, agentDir, onEvent: (event) => events.push(event) });
    await host.start();
    // Independent runtimes: commands/prompt need an explicitly opened session
    // (no implicit warm singleton anymore).
    const opened = await host.activateExecution(cwd);
    const sessionFile = opened.sessionFile as string;
    await host.activateExecution(cwd, sessionFile);
    const commands = await host.getCommands(sessionFile);
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "hello", source: "extension" }),
        expect.objectContaining({ name: "review", source: "prompt" }),
        expect.objectContaining({ name: "skill:demo-skill", source: "skill" }),
      ])
    );

    expect(host.testSessions().get(sessionFile)!.runtime.session.getToolDefinition("subagent")).toBeDefined();
    await host.prompt("/hello", undefined, undefined, sessionFile);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "extension_ui_request", method: "notify", message: "HELLO_FROM_EXTENSION" })]));
    await host.dispose();
  }, 20_000);

  it("binds extension context to the addressed session, never the foreground", async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-whoami-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project-a");
    const cwdB = join(root, "project-b");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(cwdB, { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "whoami.ts"),
      `export default function (pi) { pi.registerCommand("whoami", { description: "report bound session", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify({ file: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd }), "info") }); }\n`
    );

    const events: AgentEvent[] = [];
    const host = new PiHost({ cwd, agentDir, onEvent: (event) => events.push(event) });
    await host.start();
    const openedA = await host.activateExecution(cwd);
    const fileA = openedA.sessionFile as string;
    await host.activateExecution(cwd, fileA);
    // Project B's session becomes the foreground (the view) AFTER the
    // ownership claim; the addressed turn still runs on A — the extension
    // must observe A, not B.
    const smB = (await import("@earendil-works/pi-coding-agent")).SessionManager.create(cwdB);
    const fileB = smB.getSessionFile()!;
    await host.activateExecution(cwdB, fileB);
    expect(host.testExecutionByCwd().get(cwdB)).toBe(fileB);

    await host.prompt("/whoami", undefined, undefined, fileA);

    const report = events
      .filter((e) => e.type === "extension_ui_request")
      .map((e) => (e as { message?: string }).message ?? "")
      .find((m) => m.includes('"file"'));
    expect(report).toBeDefined();
    expect(report).toContain(fileA);
    expect(report).not.toContain(fileB);
    expect(host.testExecutionByCwd().get(cwdB)).toBe(fileB);
    await host.dispose();
  }, 20_000);
});
