// Coding-history evaluation fixtures for snapcompact.
//
// A fixture is a long synthetic coding-agent transcript seeded with
// facts a coding agent must retrieve verbatim (paths, shas, branches,
// versions, ports, identifiers, exact error messages, the user-given
// "no summarizing" rule, earlier implementation decisions, etc.), plus
// retrieval questions. Each question is graded by an exact-match
// check against expected answer(s); semantic questions include the
// expected model answer and are graded offline by a model.
//
// These fixtures are deliberately fictional and live in this file so
// the harness is deterministic and does not depend on a real project.


export interface EvalQuestion {
  id: string;
  prompt: string;
  /** What retrieval the question exercises. */
  kind: "path" | "sha" | "branch" | "version" | "port" | "command" | "identifier" | "rule" | "semantic";
  /** Accepted exact-match answers. Any one matching wins. */
  exact?: string[];
  /** Free-form answer for semantic questions; graded by a model offline. */
  semanticAnswer?: string;
}export interface EvalFixture {
  id: string;
  /** Description shown in benchmark output. */
  description: string;
  messages: any[];
  questions: EvalQuestion[];
}

const A = (role: "user" | "assistant", text: string, opts: { toolCalls?: any[]; toolResults?: Array<{ id: string; name: string; text: string; isError?: boolean }>; entryId?: string; timestamp?: number; thinking?: string } = {}): any => {
  const entryId = opts.entryId ?? `${role[0]}${Math.random().toString(36).slice(2, 6)}`;
  const timestamp = opts.timestamp ?? 0;
  if (role === "user") {
    return { role: "user", content: text, entryId, timestamp };
  }
  const content: any[] = [];
  if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
  if (text) content.push({ type: "text", text });
  const toolCalls = (opts.toolCalls ?? []).map((tc: any) => ({ id: tc.id, name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments) }));
  return { role: "assistant", content, toolCalls, entryId, timestamp };
};

const TR = (toolCallId: string, text: string, isError = false): any => ({ role: "toolResult", toolCallId, content: [{ type: "text", text }], isError, entryId: "tr" + Math.random().toString(36).slice(2, 6), timestamp: 0 });

function makeFixture(id: string, description: string, body: { user: string; assistant: string; tool?: { name: string; args: any; result: string; isError?: boolean }; thinking?: string }[], questions: EvalQuestion[]): EvalFixture {
  const messages: any[] = [];
  let ts = 1000;
  for (const step of body) {
    messages.push(A("user", step.user, { entryId: `u${messages.length}`, timestamp: ts }));
    ts += 100;
    const toolCalls = step.tool
      ? [{ id: `tc${messages.length}`, name: step.tool.name, arguments: step.tool.args }]
      : [];
    messages.push(A("assistant", step.assistant, {
      entryId: `a${messages.length}`,
      timestamp: ts,
      toolCalls,
      thinking: step.thinking,
    }));
    ts += 100;
    if (step.tool) {
      messages.push(TR(`tc${messages.length - 1}`, step.tool.result, !!step.tool.isError));
      ts += 100;
    }
  }
  return { id, description, messages, questions };
}

export const EVAL_FIXTURES: EvalFixture[] = [
  makeFixture(
    "rollout-recovery",
    "Long coding session: snapshot recovery, runtime-ownership decision, daemon fixes, CI.",
    [
      { user: "ship a recursive worktree watcher for the snapshot store", assistant: "Plan: use `fs.watch` on the project root, ignore `.git` and the snapshot storage dir.", tool: { name: "bash", args: { command: "ls electron/snapshot-store.ts" }, result: "electron/snapshot-store.ts" } },
      { user: "what file owns authoritative snapshot capture?", assistant: "electron/snapshot-store.ts owns `SnapshotStore.captureInner`.", thinking: "I need to be precise." },
      { user: "branch it and write a test for the noop fast path", assistant: "Branch name: feat/snapopt. Test fixture: 2000-file repo, write 1 file, capture twice.", tool: { name: "bash", args: { command: "git checkout -b feat/snapopt" }, result: "Switched to a new branch 'feat/snapopt'" } },
      { user: "the user said do not summarize with an LLM for the snapshot pipeline. enforce that.", assistant: "Acknowledged: snapshot generation must remain local and deterministic. No LLM call in the capture path." },
      { user: "fix the disconnect-blip ownership bug: process-spawn and task-spawn fall back to local state when the daemon is owned but the socket is down.", assistant: "Use `isDaemonOwned()` for the branch, `requireDaemonClient()` for the request. Throw on disconnected rather than fall back." },
      { user: "add a PiHost-level regression that reproduces the destructive rollback race.", assistant: "Pattern: agent writes B, user immediately writes C, prepareRollback then commitRollback. The drift guard inside commitRollback must see C and refuse." },
      { user: "what was the git sha of the commit that introduced the reconciliation loop fix?", assistant: "The reconciliation loop fix landed in commit 3335ebf (Fix reconciliation, untracked discovery, and oversize transition semantics)." },
      { user: "pin the exact Pi version for CI", assistant: "Pinned @earendil-works/pi-coding-agent@0.84.3 in the workflow. Install globally with --ignore-scripts then run scripts/link-pi.mjs." },
      { user: "what command reproduces the test failure?", assistant: "pnpm run bench:snapshot -- --scales 10000,50000,100000 --iterations 3 --worktree-scale 5000" },
      { user: "what port did we use for the local-only stub?", assistant: "No external port; the tests bind ephemeral ports via net.createServer(). 0.0.0.0:0." },
    ],
    [
      { id: "q1", kind: "path", prompt: "Which file owns authoritative snapshot capture?", exact: ["electron/snapshot-store.ts"] },
      { id: "q2", kind: "identifier", prompt: "Which function owns authoritative snapshot capture?", exact: ["captureInner", "SnapshotStore.captureInner"] },
      { id: "q3", kind: "identifier", prompt: "Which class owns it?", exact: ["SnapshotStore"] },
      { id: "q4", kind: "branch", prompt: "What branch was created for the optimization work?", exact: ["feat/snapopt"] },
      { id: "q5", kind: "sha", prompt: "What git sha introduced the reconciliation loop fix?", exact: ["3335ebf"] },
      { id: "q6", kind: "version", prompt: "What exact Pi version was pinned in CI?", exact: ["0.84.3"] },
      { id: "q7", kind: "port", prompt: "What port did the test use for the local-only stub?", exact: ["0", "0.0.0.0:0"] },
      { id: "q8", kind: "command", prompt: "What command reproduces the snapshot benchmark?", exact: ["pnpm run bench:snapshot"] },
      { id: "q9", kind: "rule", prompt: "What rule did the user give about LLM use for snapshots?", exact: ["no LLM", "do not summarize", "no llm", "must remain local", "no llm in the capture path"] },
      { id: "q10", kind: "semantic", prompt: "What was the early implementation decision about the worktree watcher ignore list?", semanticAnswer: "The watcher should ignore .git and the snapshot storage directory so changes there do not mark the worktree dirty." },
    ],
  ),
];
