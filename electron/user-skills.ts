import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UserSkillEntry {
  /** Full command name (`skill:review`). */
  name: string;
  description: string;
}

const SKILL_DIR = /^[a-z0-9-]+$/;

/** User-level skills root. Overridable for tests. */
export function userSkillsDir(): string {
  return process.env.BABYLON_USER_SKILLS_DIR ?? join(homedir(), ".agents", "skills");
}

/**
 * Frontmatter identity for one SKILL.md. The `name:` field wins; the directory
 * name is the fallback when it looks like a skill name. Anything else (missing
 * file, no usable name) is skipped — same spirit as pi's own collector.
 */
export function parseSkillFrontmatter(content: string, dirName: string): UserSkillEntry | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const name = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/m.exec(frontmatter)?.[1] ?? (SKILL_DIR.test(dirName) ? dirName : null);
  if (!name) return null;
  const description = /^description:\s*["']?(.*?)["']?\s*$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  return { name: `skill:${name}`, description };
}

/** All valid user skills, in directory order. Missing dir reads as empty. */
export function readUserSkillEntries(dir: string = userSkillsDir()): UserSkillEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: UserSkillEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries.sort()) {
    const file = join(dir, entry, "SKILL.md");
    let content: string;
    try {
      if (!statSync(file).isFile()) continue;
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillFrontmatter(content, entry);
    if (!parsed || seen.has(parsed.name.toLowerCase())) continue;
    seen.add(parsed.name.toLowerCase());
    out.push(parsed);
  }
  return out;
}

/**
 * Union pi's commands with user-dir skills. Matching is case-insensitive on
 * the full name and pi's entries win ties — the user dir only fills gaps.
 */
export function mergeSkillEntries<T extends { name: string }>(existing: T[], extra: T[]): T[] {
  const seen = new Set(existing.map((c) => c.name.toLowerCase()));
  const out: T[] = [...existing];
  for (const skill of extra) {
    if (seen.has(skill.name.toLowerCase())) continue;
    seen.add(skill.name.toLowerCase());
    out.push(skill);
  }
  return out;
}
