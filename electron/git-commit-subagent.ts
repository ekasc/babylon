export function buildCommitPushTask(userPrompt: string): string {
  const custom = userPrompt.trim();
  return `You are handling an explicit Commit & push action for the current repository.

Complete this task yourself with shell commands:
1. Inspect git status, the full staged and unstaged diff, untracked files, and recent commit subjects.
2. Respect .gitignore and Git's standard exclude rules. Never add ignored files.
3. Write an accurate commit message for the current changes.
4. Run git add -A, commit the intended working-tree changes, and push the current branch. Set the upstream only when the branch does not have one.
5. Report the commit SHA, subject, branch, and push result.

Commit-writing rules from the Unslop skill:
- Use plain, active language and concrete code or product nouns.
- State what changed and why. Match clear repository conventions.
- Remove puffery, filler, AI vocabulary, vague claims, forced groups of three, generic conclusions, and promotional phrasing.
- Do not use em dashes, decorative labels, title case, synonym cycling, or mention the generation process.
- Keep the imperative subject at 72 characters or fewer with no trailing period. Use a short body only when it adds information.

Safety rules:
- Do not edit source files.
- Do not stash, reset, checkout, rebase, pull, amend, delete files, or force-push.
- Do not bypass hooks. If a hook or Git command fails, stop and report the exact failure.
- Do not ask a question. This button is the user's explicit approval to commit and push the current changes.
${custom ? `\nAdditional user commit instructions:\n${custom.slice(0, 4_000)}\n` : ""}`;
}
