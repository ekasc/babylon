export interface SkillRef {
	/** Skill name without the "skill:" prefix, e.g. "review" for "/skill:review". */
	name: string;
	/**
	 * True when the message body carries the full SKILL.md content (a pasted or
	 * agent-injected document) rather than a bare invocation. The UI collapses
	 * such messages to a chip and hides the markdown behind a toggle, so the
	 * session transcript never shows the whole document inline.
	 */
	full: boolean;
}

/** Display name for a skill command (`skill:review` → `review`). */
export function stripSkillPrefix(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

/**
 * Expand `$name` mentions to canonical `/skill:name` invocations.
 *
 * Only exact, known skill names expand, `$5`, `$HOME`, and unknown names pass
 * through untouched, as do longer names sharing a prefix (longest wins). The
 * transcript therefore carries just the invocation chip, never pasted content.
 */
export function expandSkillMentions(text: string, skillNames: string[]): string {
  const names = [...new Set(skillNames.filter((n) => n.length > 0))].sort((a, b) => b.length - a.length);
  if (!text.includes("$") || names.length === 0) return text;
  const pattern = new RegExp(`\\$(${names.map(escapeRegExp).join("|")})(?![a-z0-9-])`, "g");
  return text.replace(pattern, (_match, name: string) => `/skill:${name}`);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SKILL_SLASH = /^\/skill:([a-z0-9][a-z0-9-]*)/;
const SKILL_FM = /---[\s\S]*?\bname:\s*([a-z0-9-]+)\b/;
const SKILL_BODY = /\bname:\s*([a-z0-9-]+)/;

/**
 * Detect a skill reference in a user message.
 *
 * - A bare invocation "/skill:name" (optionally followed by a one-line argument)
 *   resolves to { name, full:false }, the renderer shows the chip plus any args.
 * - A pasted / agent-injected SKILL.md (YAML frontmatter with name + description,
 *   or a long "# Title" + description body) resolves to { name, full:true } so the
 *   UI collapses the document to a chip instead of rendering it inline.
 *
 * A skill invocation ships only the "/skill:name" chip; the agent reads SKILL.md
 * itself (via the read tool), so the full markdown must never be user-pasted.
 */
export function parseSkillRef(text: string): SkillRef | null {
	// Explicit invocation: "/skill:name"
	const slash = text.match(SKILL_SLASH);
	if (slash) {
		const rest = text.slice(slash[0].length).trim();
		// A newline after the chip means a document was pasted, not a one-line arg.
		const full = /\n/.test(rest);
		return { name: slash[1], full };
	}

	// Pasted / injected SKILL.md: frontmatter starts the document.
	const body = text.trimStart();
	if (body.startsWith("---")) {
		const fm = body.match(SKILL_FM);
		if (fm && (body.includes("description:") || body.includes("# "))) {
			return { name: fm[1], full: true };
		}
	}
	// Fallback: a long body with a title and a name/description field.
	if (text.length > 800 && text.includes("# ") && text.includes("description:")) {
		const m2 = text.match(SKILL_BODY);
		if (m2) return { name: m2[1], full: true };
	}
	return null;
}
