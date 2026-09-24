import { describe, expect, it } from "vitest";
import {
  botAvatarHue,
  botChatForProject,
  botHandle,
  botInitials,
  buildBotSystemPrompt,
  buildGroupSystemPrompt,
  createBot,
  createGroup,
  defaultBotHandle,
  groupAnchorCwd,
  isBotMainSession,
  isGroupRoom,
  isPassReply,
  mentionedMembers,
  parseBotMentions,
  rankBots,
  resolveBot,
  resolveSharedChatOrder,
  routineJobName,
  slugifyBotName,
  validateDefaultBot,
  validateNewBot,
  validateNewGroup,
  type Bot,
} from "./bots";

function bot(over: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Reviewer",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("babylon bots", () => {
  it("slugifies names to handles", () => {
    expect(slugifyBotName("Research Buddy")).toBe("research-buddy");
    expect(slugifyBotName("  CI  Watch ")).toBe("ci-watch");
    expect(botHandle(bot({ name: "Research Buddy" }))).toBe("research-buddy");
  });

  it("derives deterministic avatar hue + initials", () => {
    expect(botAvatarHue("Reviewer")).toBe(botAvatarHue("Reviewer"));
    expect(botInitials("Research Buddy")).toBe("RB");
    expect(botInitials("planner")).toBe("PL");
  });

  it("validates new-bot input", () => {
    expect(validateNewBot({ name: "  " }).ok).toBe(false);
    expect(validateNewBot({ name: "@bad" }).ok).toBe(false);
    const ok = validateNewBot({ name: "  Reviewer ", title: "Sec" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.name).toBe("Reviewer");
  });

  it("creates a bot with normalized fields", () => {
    const created = createBot({ name: " Reviewer ", persona: "  be terse " }, 42);
    expect("error" in created).toBe(false);
    if ("error" in created) return;
    expect(created.name).toBe("Reviewer");
    expect(created.persona).toBe("be terse");
    expect(created.mainSessionFile).toBeNull();
    expect(created.createdAt).toBe(42);
  });

  it("resolves bots by id, handle, then name", () => {
    const bots = [bot({ id: "bot-1", name: "Research Buddy" }), bot({ id: "bot-2", name: "Reviewer" })];
    expect(resolveBot(bots, "bot-2")?.name).toBe("Reviewer");
    expect(resolveBot(bots, "@research-buddy")?.id).toBe("bot-1");
    expect(resolveBot(bots, "reviewer")?.id).toBe("bot-2");
    expect(resolveBot(bots, "@nobody")).toBeUndefined();
  });

  it("parses @mentions in order, deduped", () => {
    expect(parseBotMentions("@reviewer have a look, and @research-buddy too @reviewer")).toEqual([
      "reviewer",
      "research-buddy",
    ]);
    expect(parseBotMentions("email me@example.com is not a mention")).toEqual([]);
  });

  it("ranks bots for @-completion: prefix beats substring, hidden excluded", () => {
    const bots = [
      bot({ id: "a", name: "Researcher", title: "Deep search" }),
      bot({ id: "b", name: "Reviewer", title: "Security" }),
      bot({ id: "c", name: "Helper", hidden: true }),
    ];
    expect(rankBots(bots, "").map((b) => b.name)).toEqual(["Researcher", "Reviewer"]);
    expect(rankBots(bots, "rev").map((b) => b.name)).toEqual(["Reviewer"]);
    expect(rankBots(bots, "search").map((b) => b.name)).toEqual(["Researcher"]);
    expect(rankBots(bots, "help")).toEqual([]);
    expect(rankBots(bots, "@reviewer").map((b) => b.name)).toEqual(["Reviewer"]);
  });

  it("names routines with the bot namespace", () => {
    expect(routineJobName("reviewer", "Morning triage")).toBe("[bot:reviewer] Morning triage");
  });

  it("matches canonical forever-chats exactly", () => {
    expect(isBotMainSession(bot({ mainSessionFile: "/s/1.jsonl" }), "/s/1.jsonl")).toBe(true);
    expect(isBotMainSession(bot({ mainSessionFile: null }), "/s/1.jsonl")).toBe(false);
  });

  it("builds a handoff-only system prompt with roster", () => {
    const prompt = buildBotSystemPrompt(
      bot({ name: "Reviewer", title: "Security reviewer", persona: "Be terse." }),
      [bot({ id: "bot-1", name: "Reviewer" }), bot({ id: "bot-9", name: "Researcher", title: "Research" })]
    );
    expect(prompt).toContain("You are Reviewer, Security reviewer");
    expect(prompt).toContain("Be terse.");
    expect(prompt).toContain("@researcher");
    expect(prompt).toContain("cannot message them directly");
    expect(prompt).toContain("canonical chat");
  });

  it("validates groups: 2-6 members, unique-ulike names checked by store", () => {
    expect(validateNewGroup({ name: "  ", memberIds: ["a", "b"] }).ok).toBe(false);
    expect(validateNewGroup({ name: "Squad", memberIds: ["a"] }).ok).toBe(false);
    expect(validateNewGroup({ name: "Squad", memberIds: ["a", "b", "c", "d", "e", "f", "g"] }).ok).toBe(false);
    const ok = validateNewGroup({ name: "  Squad ", memberIds: ["a", "b", "b"] });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.name).toBe("Squad");
      expect(ok.value.memberIds).toEqual(["a", "b"]);
    }
  });

  it("creates groups with canonical rooms", () => {
    const created = createGroup({ name: "Squad", memberIds: ["a", "b"] }, 7);
    expect("error" in created).toBe(false);
    if ("error" in created) return;
    expect(created.mainSessionFile).toBeNull();
    expect(created.createdAt).toBe(7);
    expect(isGroupRoom(created, "/g/1.jsonl")).toBe(false);
    expect(isGroupRoom({ ...created, mainSessionFile: "/g/1.jsonl" }, "/g/1.jsonl")).toBe(true);
  });

  it("detects PASS replies for round settling", () => {
    expect(isPassReply("")).toBe(true);
    expect(isPassReply("PASS")).toBe(true);
    expect(isPassReply("pass with nothing new here")).toBe(true);
    expect(isPassReply("Nothing to add.")).toBe(true);
    expect(isPassReply("Looks good, ship it")).toBe(false);
    expect(isPassReply("I passionately disagree")).toBe(false);
  });

  it("builds a group room prompt with condensed roster", () => {
    const prompt = buildGroupSystemPrompt(
      { id: "g", name: "Squad", memberIds: ["a", "b"], createdAt: 0, updatedAt: 0 },
      [
        bot({ id: "a", name: "Reviewer", title: "Security", persona: "Be terse." }),
        bot({ id: "b", name: "Researcher" }),
      ]
    );
    expect(prompt).toContain('"Squad"');
    expect(prompt).toContain("@reviewer");
    expect(prompt).toContain("Be terse.");
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("Routing works");
  });

  it("routes spoke-turn mentions to roster-ordered targets", () => {
    const members = [
      bot({ id: "a", name: "Brain" }),
      bot({ id: "b", name: "Hands" }),
      bot({ id: "c", name: "Check" }),
    ];
    expect(mentionedMembers(members, "a", "@hands take this, @check audit after")).toEqual([members[1], members[2]]);
    expect(mentionedMembers(members, "a", "no mentions here")).toEqual([]);
    // Speaker never routes to themselves.
    expect(mentionedMembers(members, "b", "@hands do it")).toEqual([]);
    // Unknown handles are ignored.
    expect(mentionedMembers(members, "a", "@nobody hi")).toEqual([]);
  });

  it("validates a default-bot identity like a bot without a home", () => {
    expect(validateDefaultBot({ name: "  " }).ok).toBe(false);
    expect(validateDefaultBot({ name: "@bad" }).ok).toBe(false);
    const ok = validateDefaultBot({ name: " Helper ", persona: " be kind " });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.name).toBe("Helper");
      expect(ok.value.persona).toBe("be kind");
    }
    expect(defaultBotHandle({ name: "Research Buddy" })).toBe("research-buddy");
  });

  it("resolves per-project chats with legacy fallback", () => {
    const h = "abc123";
    expect(botChatForProject(bot({ mainSessionFile: "/s/old.jsonl" }), h)).toBe("/s/old.jsonl");
    expect(
      botChatForProject(bot({ mainSessionFile: "/s/old.jsonl", sessionsByProject: { [h]: "/s/new.jsonl" } }), h)
    ).toBe("/s/new.jsonl");
    expect(botChatForProject(bot({ mainSessionFile: null }), h)).toBeNull();
  });

  it("anchors homeless groups to own cwd, then first-member cwd", () => {
    const members = [bot({ id: "a", name: "A", cwd: "/repo" }), bot({ id: "b", name: "B" })];
    expect(groupAnchorCwd({ memberIds: ["a", "b"], cwd: "/other" }, members)).toBe("/other");
    expect(groupAnchorCwd({ memberIds: ["a", "b"] }, members)).toBe("/repo");
    expect(groupAnchorCwd({ memberIds: ["b"] }, members)).toBeNull();
  });
});

describe("resolveSharedChatOrder", () => {
  const brain = bot({ id: "brain", name: "Brain" });
  const hands = bot({ id: "hands", name: "Hands" });
  const members = [brain, hands];

  it("fires on the default bot's @handoff in its reply, not just user mentions", () => {
    // Reported transcript: user said "pass it along to hands" (no @) and the
    // default bot replied with a quoted "@hands, take over" handoff.
    const order = resolveSharedChatOrder(
      members,
      "implement the changes. pass it along to hands",
      'Handing to @hands. @hands, "Take over implementation of the audit fixes."',
      false
    );
    expect(order.map((m) => m.id)).toEqual(["hands"]);
  });

  it("still fires on a direct user @-mention", () => {
    expect(
      resolveSharedChatOrder(members, "@hands build it", "On it.", false).map((m) => m.id)
    ).toEqual(["hands"]);
  });

  it("unions user and reply mentions in roster order", () => {
    const order = resolveSharedChatOrder(members, "@hands build it", "@brain plan first", false);
    expect(order.map((m) => m.id)).toEqual(["brain", "hands"]);
  });

  it("stays quiet with no mentions unless free discussion is on", () => {
    expect(resolveSharedChatOrder(members, "do an audit", "Audit in progress.", false)).toEqual([]);
    expect(
      resolveSharedChatOrder(members, "do an audit", "Audit in progress.", true).map((m) => m.id)
    ).toEqual(["brain", "hands"]);
  });

  it("ignores handles that match no staffed member", () => {
    expect(
      resolveSharedChatOrder(members, "do it", "@nobody do it", false)
    ).toEqual([]);
  });
});
