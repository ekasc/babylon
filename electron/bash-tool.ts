// Babylon shell tool — wraps pi-coding-agent's built-in bash tool so the
// renderer can show: exit code, signal, duration, the parsed argv, and a
// short usage hint. The wrapper intercepts only the display side; the
// underlying pi tool still owns execution, output streaming, cancellation, and
// truncation behavior.

import { createBashTool, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BashToolInput, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { wireArr, wireOf, wireStr } from "../src/store";
import type { BabylonBashMeta } from "../src/store";

type ShellHint = { kind: "explain"; label: string; description: string };

function buildHints(command: string): ShellHint[] {
  const hints: ShellHint[] = [];
  const lower = command.trim().toLowerCase();
  if (/^ls\b/.test(lower)) {
    hints.push({ kind: "explain", label: "ls", description: "List directory. Add -la for details, --color=auto for color." });
  } else if (/^cat\b/.test(lower)) {
    hints.push({ kind: "explain", label: "cat", description: "Concatenate and print files. Prefer head/tail for snippets, less for paging." });
  } else if (/^rm\b/.test(lower)) {
    hints.push({ kind: "explain", label: "rm", description: "Destructive. Prefer `trash` (osascript) or git clean to keep a recovery path." });
  } else if (/^git\b/.test(lower)) {
    hints.push({ kind: "explain", label: "git", description: "Local git. For history edits use `git rebase -i`, never `--force` without coordination." });
  } else if (/^cd\b/.test(lower)) {
    hints.push({ kind: "explain", label: "cd", description: "Shell built-in. Each command runs in its own subshell — cwd doesn't persist between calls." });
  } else if (/^pwd$/.test(lower)) {
    hints.push({ kind: "explain", label: "pwd", description: "Print current working directory." });
  } else if (/^echo\b/.test(lower)) {
    hints.push({ kind: "explain", label: "echo", description: "Print text. Prefer printf for reliable escaping." });
  } else if (/^grep\b/.test(lower) || /^rg\b/.test(lower)) {
    hints.push({ kind: "explain", label: lower.startsWith("rg") ? "rg" : "grep", description: "Search inside files. rg is faster; both stream to stdout." });
  } else if (/^find\b/.test(lower)) {
    hints.push({ kind: "explain", label: "find", description: "Walk the filesystem. Use -type f for files only, -name '*.ts' to narrow." });
  } else if (/^sed\b/.test(lower) || /^awk\b/.test(lower)) {
    hints.push({ kind: "explain", label: command.split(/\s+/, 1)[0] ?? command, description: "Stream-edit. Use -i.bak to keep a rollback copy." });
  } else if (/^curl\b/.test(lower) || /^wget\b/.test(lower)) {
    hints.push({ kind: "explain", label: command.split(/\s+/, 1)[0] ?? command, description: "Network fetch. Add --fail-with-body and a timeout; never pipe to a shell." });
  } else if (/^npm\b/.test(lower) || /^pnpm\b/.test(lower) || /^yarn\b/.test(lower)) {
    hints.push({ kind: "explain", label: command.split(/\s+/, 1)[0] ?? command, description: "Package manager. Pin to install, never run scripts blindly in untrusted repos." });
  } else if (/^node\b/.test(lower) || /^python\b/.test(lower) || /^ruby\b/.test(lower)) {
    hints.push({ kind: "explain", label: command.split(/\s+/, 1)[0] ?? command, description: "Interpreter. Watch for shebangs and module syntax errors." });
  }
  return hints.slice(0, 2);
}

const UNSAFE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+-rf?\s+\/(?!\w)/, label: "rm -rf /" },
  { re: /:\(\)\s*\{.*:&.*\}\s*;:/, label: "fork bomb" },
  { re: /\bdd\s+if=.+of=\/dev\/(disk|sd|hd)/, label: "dd to disk device" },
  { re: /\bmkfs(?:\.\w+)?\s+\/dev\//, label: "mkfs on a device" },
  { re: /\bchmod\s+-R\s+777\s+\//, label: "chmod 777 /" },
  { re: /\bcurl\s+.+\|\s*(?:sudo\s+)?(?:ba)?sh\b/, label: "curl | sh" },
  { re: />\s*\/dev\/sd[a-z]/, label: "redirect to /dev/sd*" },
  { re: /\bchown\s+-R\s+\w+\s+\//, label: "chown /" },
];

function detectUnsafe(command: string): string | null {
  for (const { re, label } of UNSAFE_PATTERNS) {
    if (re.test(command)) return label;
  }
  return null;
}

function tokenizeArgv(command: string): string[] {
  // Lightweight POSIX-ish tokenizer: handles single/double quotes and backslash
  // escapes, ignoring shell comments and the very common here-docs we'd never
  // tokenize well anyway. This is purely for the UI's display chip.
  const out: string[] = [];
  let i = 0;
  let buf = "";
  let quote: "'" | '"' | null = null;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        buf += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      buf += command[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(ch ?? "")) {
      if (buf) out.push(buf);
      buf = "";
      // skip the run of whitespace
      while (i < command.length && /\s/.test(command[i] ?? "")) i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf) out.push(buf);
  return out;
}

function shortCwd(cwd: string): string {
  if (!cwd) return "";
  const parts = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `~/.../${parts.slice(-2).join("/")}`;
}

export function createBabylonBashTool(cwd: string): ToolDefinition {
  const inner = createBashTool(cwd);
  const innerDef = createBashToolDefinition(cwd);

  return {
    name: innerDef.name,
    label: innerDef.label,
    description: innerDef.description,
    promptSnippet: innerDef.promptSnippet,
    promptGuidelines: innerDef.promptGuidelines,
    parameters: innerDef.parameters,
    async execute(toolCallId: string, args, signal, onUpdate, ctx) {
      const command: string = String(wireOf(args)?.command ?? "");
      const startedAt = Date.now();
      const argv = tokenizeArgv(command);
      const head = argv[0] || "";
      const headBase = head.split("/").pop() || head;
      const unsafe = detectUnsafe(command);
      const hints = buildHints(command);
      const callId = toolCallId || `babylon-bash-${randomUUID()}`;
      // Last content snapshot, re-emitted with every update so the renderer
      // can render a header immediately (pi also fires its own initial
      // update; subsequent calls re-emit the stored snapshot).
      let lastContent: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      const emit = (extra: {
        endedAt?: number;
        exitCode?: number;
        exitSignal?: string;
        status?: BabylonBashMeta["status"];
        truncated?: boolean;
        fullOutputPath?: string;
        truncation?: unknown;
      } = {}) => {
        if (!onUpdate) return;
        const meta: BabylonBashMeta = {
          kind: "babylon_bash",
          version: 1,
          callId,
          command,
          argv,
          head,
          headBase,
          startedAt,
          endedAt: extra.endedAt,
          exitCode: extra.exitCode,
          exitSignal: extra.exitSignal,
          status: extra.status ?? "running",
          cwd: shortCwd(cwd),
          truncated: extra.truncated ?? false,
          fullOutputPath: extra.fullOutputPath,
          unsafe,
          hints,
          durationMs: extra.endedAt ? extra.endedAt - startedAt : undefined,
        };
        onUpdate({
          content: lastContent,
          details: {
            babylon: meta,
            ...(extra.truncation ? { truncation: extra.truncation } : {}),
            ...(extra.fullOutputPath ? { fullOutputPath: extra.fullOutputPath } : {}),
          },
        });
      };

      // Initial empty update with command metadata so the renderer can render
      // a header immediately. Pi also fires its own initial update; we set
      // the last content snapshot on the callback so subsequent calls
      // re-emit it.
      try {
        const result = await inner.execute(callId, args as BashToolInput, signal, (u) => {
          if (!onUpdate) return;
          const update = wireOf(u);
          const content = wireArr(update, "content") ?? [];
          // Keep only well-formed blocks: the snapshot re-renders verbatim,
          // so a malformed block must not reach the transcript.
          const blocks: typeof lastContent = [];
          for (const b of content) {
            const w = wireOf(b);
            if (w?.type === "text" && typeof w.text === "string") blocks.push({ type: "text", text: w.text });
            else if (w?.type === "image" && typeof w.data === "string" && typeof w.mimeType === "string") {
              blocks.push({ type: "image", data: w.data, mimeType: w.mimeType });
            }
          }
          lastContent = blocks;
          onUpdate({
            ...(update ?? {}),
            content: lastContent,
            details: {
              ...(wireOf(update?.details) ?? {}),
              babylon: {
                kind: "babylon_bash",
                version: 1,
                callId,
                command,
                argv,
                head,
                headBase,
                startedAt,
                status: "running",
                cwd: shortCwd(cwd),
                truncated: false,
                unsafe,
                hints,
              } satisfies BabylonBashMeta,
            },
          });
        });
        const endedAt = Date.now();
        const resultContent = wireArr(wireOf(result), "content") ?? [];
        const text = resultContent
          .map((b) => wireStr(wireOf(b), "text") ?? "")
          .join("");
        // Pi throws an Error with a "Command exited with code N" suffix when
        // exitCode !== 0. We want the renderer to still see the actual exit
        // code, so we re-extract and pass it through even on error.
        let exitCode: number | undefined;
        let exitSignal: string | undefined;
        const resultError = wireStr(wireOf(result), "error");
        const exitMatch = /exited with code (-?\d+)/.exec(resultError ?? "");
        if (exitMatch) exitCode = Number(exitMatch[1]);
        const sigMatch = /(SIG[A-Z]+|killed by signal \d+)/.exec(resultError ?? "");
        if (sigMatch) exitSignal = sigMatch[1];
        const details = wireOf(wireOf(result)?.details) ?? {};
        emit({
          endedAt,
          exitCode,
          exitSignal,
          status: exitCode === undefined ? (exitSignal ? "signaled" : "completed") : "exited",
          truncated: wireOf(details.truncation)?.truncated === true,
          fullOutputPath: wireStr(details, "fullOutputPath"),
          truncation: details.truncation,
        });
        return result;
      } catch (err) {
        const endedAt = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        let exitCode: number | undefined;
        let exitSignal: string | undefined;
        const exitMatch = /exited with code (-?\d+)/.exec(msg);
        if (exitMatch) exitCode = Number(exitMatch[1]);
        const sigMatch = /(SIG[A-Z]+|killed by signal \d+)/.exec(msg);
        if (sigMatch) exitSignal = sigMatch[1];
        const timedOut = /timed out after (\d+)/.test(msg);
        const aborted = /aborted/.test(msg);
        const status = timedOut ? "timeout" : aborted ? "aborted" : exitCode !== undefined ? "exited" : exitSignal ? "signaled" : "failed";
        // Last-chance emit so the renderer still sees the metadata.
        onUpdate?.({
          content: lastContent,
          details: {
            babylon: {
              kind: "babylon_bash",
              version: 1,
              callId,
              command,
              argv,
              head,
              headBase,
              startedAt,
              endedAt,
              exitCode,
              exitSignal,
              status,
              cwd: shortCwd(cwd),
              unsafe,
              hints,
              durationMs: endedAt - startedAt,
            },
          },
        });
        // Strip the synthetic "Command exited with code N" suffix pi appended
        // so the rendered text just shows the original output.
        const cleaned = msg.replace(/\n\nCommand exited with code -?\d+$/, "").replace(/\n\nCommand timed out after \d+ seconds$/, "").replace(/\n\nCommand aborted$/, "");
        throw new Error(cleaned);
      }
    },
  };
}
