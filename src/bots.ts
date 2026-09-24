// Babylon Bot Mode, Hermes-style Bots, Babylon-improved.
//
// A Bot is a named specialist: its own persona (SOUL.md equivalent),
// optional model pin, home project, and one canonical forever-chat.
// Hermes parity: Bot ≈ profile (isolated identity + memory + history).
// Babylon v1: logical isolation (shared pi agentDir/sessions); per-bot
// agentDir/stateDir paths are reserved on the type for a future true
// filesystem-isolation upgrade without migrating callers.
//
// Improvements over Hermes for Babylon (desktop coding workspace):
// - Single-runtime honesty: no fake background delivery. @mentions hand off
//   with an explicit quoted context switch, never a hidden send.
// - Canonical chat is append-only like every pi session; /new inside a Bot
//   chat compacts instead of forking the relationship.
// - Truthful presence comes from real Activity (threads/subagents), not
//   invented status.

import { makeId } from "./runtime";

export interface BotModelRef {
  provider: string;
  modelId: string;
}

export interface Bot {
  id: string;
  /** Display name. Unique case-insensitively within the registry. */
  name: string;
  /** Role line, e.g. "Security reviewer". Shown in roster + teammate lists. */
  title?: string;
  /** One-paragraph remit. Shown in roster tooltip + new-agent review. */
  description?: string;
  /** Standing instructions (Hermes SOUL.md equivalent). Injected as pi
   *  appendSystemPrompt for this bot's sessions. Empty = inherit global. */
  persona?: string;
  /** Model pin. Absent = follow the global chat model. */
  model?: BotModelRef;
  /** Home project cwd. New bot chats open here when set. */
  cwd?: string;
  /** Canonical forever-chat session file. Null until first opened. */
  mainSessionFile?: string | null;
  /** Hidden bots stay out of the roster but still resolve @mentions and
   *  keep running routines. Display-only, like Hermes hide. */
  hidden?: boolean;
  /** Reserved for true filesystem isolation (Hermes profile parity):
   *  per-bot pi agentDir/stateDir. Unset in v1 (shared global dirs). */
  agentDir?: string;
  stateDir?: string;
  /** Per-project chat files keyed by projectHash (v3). New chats write here;
   *  `mainSessionFile` below is the legacy fallback. */
  sessionsByProject?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface NewBotInput {
  name: string;
  title?: string;
  description?: string;
  persona?: string;
  model?: BotModelRef;
  cwd?: string;
}

export type BotPatch = Partial<
  Pick<Bot, "name" | "title" | "description" | "persona" | "model" | "cwd" | "hidden" | "mainSessionFile" | "sessionsByProject">
>;

const NAME_MAX = 48;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 500;
const PERSONA_MAX = 20_000;

export function newBotId(): string {
  return makeId("bot");
}

/** URL-safe handle: "Research Buddy" -> "research-buddy". */
export function slugifyBotName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "bot";
}

/** @handle form used in chat + autocomplete. */
export function botHandle(bot: Pick<Bot, "name">): string {
  return slugifyBotName(bot.name);
}

/** Deterministic avatar hue (0-359) from the bot name. Same name, same face. */
export function botAvatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 1-2 initials for the avatar fallback. */
export function botInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return `${(parts[0] ?? "").charAt(0)}${(parts[parts.length - 1] ?? "").charAt(0)}`.toUpperCase();
}

/** Validate + normalize new-bot input. Returns error string or normalized input. */
export function validateNewBot(input: NewBotInput): { ok: true; value: Required<Pick<NewBotInput, "name">> & NewBotInput } | { ok: false; error: string } {
  const name = input.name.trim().replaceAll(/\s+/g, " ");
  if (!name) return { ok: false, error: "Give the bot a name" };
  if (name.length > NAME_MAX) return { ok: false, error: `Name must be ${NAME_MAX} characters or less` };
  if (name.startsWith("@")) return { ok: false, error: "Name must not start with @" };
  if ((input.title ?? "").length > TITLE_MAX) return { ok: false, error: `Title must be ${TITLE_MAX} characters or less` };
  if ((input.description ?? "").length > DESCRIPTION_MAX) return { ok: false, error: `Description must be ${DESCRIPTION_MAX} characters or less` };
  if ((input.persona ?? "").length > PERSONA_MAX) return { ok: false, error: "Persona is too long (20k character limit)" };
  if (input.model && (!input.model.provider.trim() || !input.model.modelId.trim())) {
    return { ok: false, error: "Model pin needs both provider and model id" };
  }
  if (input.cwd !== undefined && input.cwd !== "" && input.cwd.length > 4096) {
    return { ok: false, error: "Home project path is too long" };
  }
  return {
    ok: true,
    value: {
      ...input,
      name,
      title: input.title?.trim() ? input.title.trim() : undefined,
      description: input.description?.trim() ? input.description.trim() : undefined,
      persona: input.persona?.trim() ? input.persona.trim() : undefined,
      cwd: input.cwd?.trim() ? input.cwd.trim() : undefined,
    },
  };
}

export function createBot(input: NewBotInput, now = Date.now()): Bot | { error: string } {
  const validated = validateNewBot(input);
  if (!validated.ok) return { error: validated.error };
  const v = validated.value;
  return {
    id: newBotId(),
    name: v.name,
    ...(v.title ? { title: v.title } : {}),
    ...(v.description ? { description: v.description } : {}),
    ...(v.persona ? { persona: v.persona } : {}),
    ...(v.model ? { model: { provider: v.model.provider.trim(), modelId: v.model.modelId.trim() } } : {}),
    ...(v.cwd ? { cwd: v.cwd } : {}),
    mainSessionFile: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Find a bot by id, @handle, or name (case-insensitive). Handle wins on collision. */
export function resolveBot(bots: Bot[], ref: string): Bot | undefined {
  const q = ref.trim().replace(/^@/, "").toLowerCase();
  if (!q) return undefined;
  const byId = bots.find((b) => b.id === ref);
  if (byId) return byId;
  const byHandle = bots.find((b) => botHandle(b) === q);
  if (byHandle) return byHandle;
  return bots.find((b) => b.name.toLowerCase() === q);
}

/** @mentions in a message, in order, deduped, without the @. */
export function parseBotMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(>])@([a-z0-9][a-z0-9_-]*)/gi)) {
    const handle = (m[1] ?? "").toLowerCase();
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

/**
 * Rank bots for @-mention completion: exact-handle/name prefix first, then
 * substring over name/handle/title. Hidden bots never complete. Capped.
 */
export function rankBots(bots: Bot[], query: string, limit = 8): Bot[] {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const visible = bots.filter((b) => !b.hidden);
  if (!q) return visible.slice(0, limit);
  const scored: Array<{ bot: Bot; score: number }> = [];
  for (const bot of visible) {
    const handle = botHandle(bot);
    const name = bot.name.toLowerCase();
    const title = (bot.title ?? "").toLowerCase();
    let score = -1;
    if (handle === q || name === q) score = 0;
    else if (handle.startsWith(q) || name.startsWith(q)) score = 1;
    else if (handle.includes(q) || name.includes(q) || (title && title.includes(q))) score = 2;
    if (score >= 0) scored.push({ bot, score });
  }
  scored.sort((a, b) => a.score - b.score || a.bot.name.localeCompare(b.bot.name));
  return scored.slice(0, limit).map((s) => s.bot);
}

/** Hermes-style routine job name: "[bot:reviewer] Morning triage". */
export function routineJobName(botName: string, routine: string): string {
  return `[bot:${botName}] ${routine}`;
}

/** True when this session file is the bot's canonical forever-chat. */
export function isBotMainSession(bot: Pick<Bot, "mainSessionFile">, sessionFile: string | null | undefined): boolean {
  if (!sessionFile || !bot.mainSessionFile) return false;
  return bot.mainSessionFile === sessionFile;
}

// ---------------------------------------------------------------------------
// Group chats: named rooms where member bots take serial turns.
// Single-runtime honesty: turns run one at a time in the shared room session
// (no parallel member sessions), stream visibly, and stop on abort.
// ---------------------------------------------------------------------------

export interface BotGroup {
  id: string;
  /** Display name. Unique case-insensitively within the registry. */
  name: string;
  memberIds: string[];
  /** Shared room session file. Null until first opened. */
  mainSessionFile?: string | null;
  /** Project the room opens in. Defaults to the active project at creation. */
  cwd?: string;
  /** Owning project hash (v3). Backfilled once from `cwd` / member cwd. */
  projectHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewGroupInput {
  name: string;
  memberIds: string[];
  cwd?: string;
}

const GROUP_NAME_MAX = 48;
const MAX_GROUP_MEMBERS = 6;

export function newGroupId(): string {
  return makeId("group");
}

export function validateNewGroup(input: NewGroupInput): { ok: true; value: { name: string; memberIds: string[]; cwd?: string } } | { ok: false; error: string } {
  const name = input.name.trim().replaceAll(/\s+/g, " ");
  if (!name) return { ok: false, error: "Give the group a name" };
  if (name.length > GROUP_NAME_MAX) return { ok: false, error: `Name must be ${GROUP_NAME_MAX} characters or less` };
  const memberIds = [...new Set((input.memberIds ?? []).filter((id) => typeof id === "string" && id))];
  if (memberIds.length < 2) return { ok: false, error: "A group needs at least 2 bots" };
  if (memberIds.length > MAX_GROUP_MEMBERS) return { ok: false, error: `A group holds at most ${MAX_GROUP_MEMBERS} bots` };
  return {
    ok: true,
    value: {
      name,
      memberIds,
      ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
    },
  };
}

export function createGroup(input: NewGroupInput, now = Date.now()): BotGroup | { error: string } {
  const validated = validateNewGroup(input);
  if (!validated.ok) return { error: validated.error };
  return {
    id: newGroupId(),
    name: validated.value.name,
    memberIds: validated.value.memberIds,
    ...(validated.value.cwd ? { cwd: validated.value.cwd } : {}),
    mainSessionFile: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** True when this session file is the group's shared room. */
export function isGroupRoom(group: Pick<BotGroup, "mainSessionFile">, sessionFile: string | null | undefined): boolean {
  if (!sessionFile || !group.mainSessionFile) return false;
  return group.mainSessionFile === sessionFile;
}

/** A member turn that contributes nothing: counts as silent for round settling. */
export function isPassReply(text: string): boolean {
  const t = text.trim().replace(/\.*$/, "").trim().toLowerCase();
  if (!t) return true;
  return /^(pass|nothing to add|nothing new|nothing further|no comment|no update|abstain)(\s+.*)?$/.test(t);
}

/**
 * Director prompt for one serial member turn. The renderer recognizes this
 * exact shape (see parseRoomTurn) and collapses the machinery, directors
 * never render as user bubbles, PASS replies become one-line notes.
 */
export function roomTurnPrompt(handle: string): string {
  return `[Room turn] @${handle}, respond briefly in your voice to the room above (or reply exactly PASS if you have nothing new).`;
}

/** Extract the addressed handle from a director prompt, or null. */
export function parseRoomTurn(text: string): string | null {
  const m = /^\[Room turn\] @([a-z0-9][a-z0-9_-]*)/i.exec(text.trim());
  return m && m[1] ? m[1].toLowerCase() : null;
}

/**
 * Mention routing: members named in a spoke turn speak next. Returns roster-
 * ordered targets excluding the speaker, the driver jumps them ahead of the
 * rotation, and an explicit mention overrides a quiet streak (being named IS
 * being invoked). Pure; the turn caps in the driver bound ping-pong loops.
 */
export function mentionedMembers(members: Bot[], speakerId: string, replyText: string): Bot[] {
  const handles = new Set(parseBotMentions(replyText));
  if (handles.size === 0) return [];
  return members.filter((m) => m.id !== speakerId && (handles.has(botHandle(m)) || handles.has(m.name.toLowerCase())));
}

/**
 * Entry order for shared (default-bot) project chats. Mention-only by
 * default: a member speaks when the user names them OR when the default
 * bot's just-finished reply hands off to them with @handle (the quoted
 * handoff the persona writes). With no mentions, free discussion opens the
 * full rotation; otherwise the room stays quiet. Roster-ordered, pure.
 */
export function resolveSharedChatOrder(members: Bot[], userText: string, assistantText: string, freeSpeak: boolean): Bot[] {
  const handles = new Set([...parseBotMentions(userText), ...parseBotMentions(assistantText)]);
  if (handles.size === 0) return freeSpeak ? [...members] : [];
  const ids = new Set(
    members
      .filter((m) => handles.has(botHandle(m)) || handles.has(m.name.toLowerCase()))
      .map((m) => m.id)
  );
  return members.filter((m) => ids.has(m.id));
}

const MEMBER_PERSONA_MAX = 2000;

/**
 * Room prompt: member roster (condensed personas so 6 members stay cache-sane)
 * plus the serial turn protocol. One room session, one overlay, member turns
 * are directed within it, so no session switching and no cache churn.
 */
export function buildGroupSystemPrompt(group: BotGroup, members: Bot[]): string {
  const lines: string[] = [];
  lines.push(`You are the facilitator of the "${group.name}" group room in Babylon, ${members.length} specialist bots coordinate here.`);
  lines.push("");
  lines.push("Members (address turns with @handle so replies stay attributable):");
  for (const m of members) {
    const persona = (m.persona ?? "").trim();
    const condensed = persona.length > MEMBER_PERSONA_MAX ? `${persona.slice(0, MEMBER_PERSONA_MAX)}…` : persona;
    lines.push(`- @${botHandle(m)}, ${m.title ?? m.name}${condensed ? `. Voice: ${condensed}` : ""}`);
  }
  lines.push(
    "",
    "Turn protocol: when the director names a member, answer briefly IN THAT MEMBER'S VOICE and nothing else, no narration. Reply with exactly PASS when you have nothing new. Never invent tool output or actions; only turns the director asks for.",
    "Routing works: naming @someone in a reply pulls them into the conversation, they speak next. Use it to hand work over instead of describing the handoff."
  );
  return lines.join("\n");
}

/**
 * Bot protocol block injected as pi appendSystemPrompt for bot sessions.
 * v1 is handoff-only (single AgentSessionRuntime cannot deliver in the
 * background): the agent composes handoffs as quoted context, never hidden
 * sends. Teammate roster gives each bot names + roles so it knows who does what.
 */
export function buildBotSystemPrompt(bot: Bot, teammates: Bot[]): string {
  const lines: string[] = [];
  lines.push(`You are ${bot.name}${bot.title ? `, ${bot.title}` : ""}, a specialist bot in Babylon.`);
  if (bot.description) lines.push(bot.description);
  if (bot.persona) lines.push("", bot.persona);
  const others = teammates.filter((t) => t.id !== bot.id && !t.hidden);
  if (others.length > 0) {
    lines.push(
      "",
      "Teammates (hand off with an explicit quoted summary addressed with @handle; you cannot message them directly):",
      ...others.map((t) => `- @${botHandle(t)}, ${t.title ?? t.name}`)
    );
  } else {
    lines.push("", "You are the only bot. Address the user directly.");
  }
  lines.push(
    "",
    "This is your canonical chat: it persists forever. Never ask to start over; compact context instead of forking."
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-project bots (v3): employees with per-project isolated chats.
// Project identity is the exact folder path; its hash is computed main-side
// (needs realpath) and only the hash travels in these records.
// ---------------------------------------------------------------------------

/** App-default template: full bot identity, snapshotted into new projects. */
export interface DefaultBot {
  name: string;
  title?: string;
  description?: string;
  persona?: string;
  model?: BotModelRef;
}

export type DefaultBotPatch = Partial<Pick<DefaultBot, "name" | "title" | "description" | "persona" | "model">>;

/** Validate + normalize an app-default or project-default bot identity. */
export function validateDefaultBot(input: DefaultBot): { ok: true; value: DefaultBot } | { ok: false; error: string } {
  const name = input.name.trim().replaceAll(/\s+/g, " ");
  if (!name) return { ok: false, error: "Give the default bot a name" };
  if (name.length > NAME_MAX) return { ok: false, error: `Name must be ${NAME_MAX} characters or less` };
  if (name.startsWith("@")) return { ok: false, error: "Name must not start with @" };
  if ((input.title ?? "").length > TITLE_MAX) return { ok: false, error: `Title must be ${TITLE_MAX} characters or less` };
  if ((input.description ?? "").length > DESCRIPTION_MAX) return { ok: false, error: `Description must be ${DESCRIPTION_MAX} characters or less` };
  if ((input.persona ?? "").length > PERSONA_MAX) return { ok: false, error: "Persona is too long (20k character limit)" };
  if (input.model && (!input.model.provider.trim() || !input.model.modelId.trim())) {
    return { ok: false, error: "Model pin needs both provider and model id" };
  }
  return {
    ok: true,
    value: {
      name,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.persona?.trim() ? { persona: input.persona.trim() } : {}),
      ...(input.model ? { model: { provider: input.model.provider.trim(), modelId: input.model.modelId.trim() } } : {}),
    },
  };
}

/** @handle for a default-bot copy (same slug rules as employees). */
export function defaultBotHandle(bot: Pick<DefaultBot, "name">): string {
  return slugifyBotName(bot.name);
}

/** System prompt for a project's default-bot copy: same shape as an employee
 *  prompt (roster + handoff + forever-chat), so overlays stay uniform. */
export function buildDefaultBotSystemPrompt(def: DefaultBot, teammates: Bot[]): string {
  return buildBotSystemPrompt(
    {
      id: "default",
      name: def.name,
      ...(def.title ? { title: def.title } : {}),
      ...(def.description ? { description: def.description } : {}),
      ...(def.persona ? { persona: def.persona } : {}),
      ...(def.model ? { model: def.model } : {}),
      createdAt: 0,
      updatedAt: 0,
    },
    teammates
  );
}

/**
 * Resolve a bot's chat file for one project. The per-project map wins;
 * legacy `mainSessionFile` is a read-only fallback. Single precedence point
 * for all readers (main + renderer agree by construction).
 */
export function botChatForProject(bot: Pick<Bot, "mainSessionFile" | "sessionsByProject">, projectHash: string): string | null {
  return bot.sessionsByProject?.[projectHash] ?? bot.mainSessionFile ?? null;
}

/**
 * Anchor cwd for a group with no project yet: its own cwd, else its first
 * member's home cwd, else null (caller falls back to the active cwd and
 * persists the anchor on first use).
 */
export function groupAnchorCwd(group: Pick<BotGroup, "cwd" | "memberIds">, bots: Array<Pick<Bot, "id" | "cwd">>): string | null {
  if (group.cwd?.trim()) return group.cwd.trim();
  const first = bots.find((b) => b.id === group.memberIds[0]);
  if (first?.cwd?.trim()) return first.cwd.trim();
  return null;
}
