import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkCanvasText, formatCheckReport } from "../src/lib/canvas-check";
import { canvasPath, readScene, writeScene } from "./canvas-store";

function textResult(t: string) {
  return { content: [{ type: "text", text: t }], details: { text: t } };
}

/**
 * Agent tools for diagrams. The agent used to write scenes with raw file tools
 * and never see the render, so diagrams came back with overlapping boxes and
 * colliding labels. canvas_check closes that loop: draft, check, fix what is
 * reported, re-check, then write. canvas_write enforces the same gate at write
 * time and refuses invalid scenes instead of saving them.
 */
export function createCanvasTools(): ToolDefinition<any, any>[] {
  const tools: ToolDefinition<any, any>[] = [
    {
      name: "canvas_check",
      label: "Check Canvas",
      description:
        "Validate canvas DSL and report layout problems (overlapping nodes, edge labels colliding with nodes) with exact ids. Check every draft BEFORE writing it, fix what is reported, and re-check until clean. Pass text to check a draft, or cwd and name to check a saved scene.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Scene text to check" },
          cwd: { type: "string", description: "Project dir, with text omitted to check a saved scene" },
          name: { type: "string", description: "Scene name, with text omitted to check a saved scene" },
        },
      } as any,
      execute: async (_id, raw) => {
        const a = (raw ?? {}) as Record<string, unknown>;
        let text = typeof a.text === "string" ? a.text : null;
        if (text == null) {
          const cwd = String(a.cwd ?? "").trim();
          const name = String(a.name ?? "").trim();
          if (!cwd || !name) throw new Error("canvas_check: provide text, or cwd and name of a saved scene");
          const saved = await readScene(canvasPath(cwd, name));
          if (saved == null) throw new Error(`canvas_check: no scene ${name}`);
          text = saved;
        }
        return textResult(formatCheckReport(checkCanvasText(text)));
      },
    } as ToolDefinition<any, any>,

    {
      name: "canvas_write",
      label: "Write Canvas",
      description:
        "Write a canvas scene after validating it. Invalid scenes are refused, never saved; layout warnings are reported but still saved. Prefer this over raw file writes for .canvas files.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["cwd", "name", "text"],
        properties: {
          cwd: { type: "string", description: "Project dir holding .pi/canvas" },
          name: { type: "string", description: "Scene name" },
          text: { type: "string", description: "Full scene text" },
        },
      } as any,
      execute: async (_id, raw) => {
        const a = (raw ?? {}) as Record<string, unknown>;
        const cwd = String(a.cwd ?? "").trim();
        const name = String(a.name ?? "").trim();
        const text = typeof a.text === "string" ? a.text : "";
        if (!cwd || !name || !text) throw new Error("canvas_write: cwd, name and text are required");
        const report = checkCanvasText(text);
        if (!report.ok) return textResult(`not written — the scene is invalid:\n${formatCheckReport(report)}`);
        await writeScene(canvasPath(cwd, name), text);
        const warnings =
          report.overlapCount + report.labelCollisionCount > 0
            ? `, but ${report.overlapCount + report.labelCollisionCount} layout problems remain:\n${formatCheckReport(report)
              .split("\n")
              .slice(1)
              .join("\n")}`
            : ", clean";
        return textResult(`wrote ${name} (${report.nodes} nodes, ${report.edges} edges)${warnings}`);
      },
    } as ToolDefinition<any, any>,
  ];
  return tools;
}
