import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PiHost } from "./pi-host";

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

    const events: any[] = [];
    const host = new PiHost({ cwd, agentDir, onEvent: (event) => events.push(event), onStatus: () => undefined });
    await host.start();
    const commands = await host.getCommands();
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "hello", source: "extension" }),
        expect.objectContaining({ name: "review", source: "prompt" }),
        expect.objectContaining({ name: "skill:demo-skill", source: "skill" }),
      ])
    );

    expect(host.session.getToolDefinition("subagent")).toBeDefined();
    await host.prompt("/hello");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "extension_ui_request", method: "notify", message: "HELLO_FROM_EXTENSION" })]));
    await host.dispose();
  }, 20_000);
});
