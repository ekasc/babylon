import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import type { CommandInfo } from "../bridge";
import type { Bot } from "../bots";
import { botHandle, rankBots } from "../bots";
import { insertCommand, rankCommands } from "../commands";
import { stripSkillPrefix } from "../lib/skillRef";
import { detectComposerTrigger } from "../lib/composerTrigger";
import CommandMenu from "./CommandMenu";
import BotMentionMenu from "./BotMentionMenu";

interface AutocompleteInput {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  commands: CommandInfo[];
  mentionBots: Bot[];
  composerRef: RefObject<HTMLTextAreaElement | null>;
  menuAnchorRef: RefObject<HTMLDivElement | null>;
}

/**
 * Autocomplete cluster for the composer input: slash-commands, @-mentions,
 * and $-skills. Owns trigger detection, ranked matches, selection indices,
 * dismissal, the anchored menu portal, and menu key handling.
 *
 * handleMenuKey returns true when it consumed the key (menu navigation,
 * Tab/Escape, or accepting a row). Enter on an already-accepted row returns
 * false so the caller can submit.
 */
export function useComposerAutocomplete(input: AutocompleteInput) {
  const { text, setText, commands, mentionBots, composerRef, menuAnchorRef } = input;
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [selectedMention, setSelectedMention] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState(0);
  const [dismissedSkill, setDismissedSkill] = useState<string | null>(null);
  const [, setMenuLayoutTick] = useState(0);

  const trigger = useMemo(() => detectComposerTrigger(text, text.length), [text]);
  const commandToken = useMemo(() => {
    if (!trigger) return null;
    if (trigger.kind === "slash-command") return trigger.query;
    if (trigger.kind === "slash-model") return trigger.query || "model";
    return null;
  }, [trigger]);
  const commandMatches = useMemo(
    () =>
      commandToken !== null && commandToken !== dismissedToken
        ? rankCommands(commands, commandToken, 16)
        : [],
    [commandToken, commands, dismissedToken]
  );

  // Bot @-mentions: the path trigger doubles as the mention token. Queries
  // containing "/" are file paths, never bot handles, bots stay out of the way.
  const mentionToken = useMemo(() => {
    if (!trigger || trigger.kind !== "path") return null;
    if (trigger.query.includes("/")) return null;
    return trigger;
  }, [trigger]);
  const mentionMatches = useMemo(
    () =>
      mentionToken && mentionToken.query !== dismissedMention && mentionBots.length
        ? rankBots(mentionBots, mentionToken.query, 8)
        : [],
    [mentionToken, mentionBots, dismissedMention]
  );

  // Skill $-mentions: autocomplete over skill commands only (display names
  // stripped of the `skill:` prefix). Choosing, or typing, `$name` inserts
  // the sigil form; submit expands known names to canonical `/skill:name` so
  // the transcript carries just the invocation chip, never pasted content.
  const skillCommands = useMemo(
    () => commands.filter((c) => c.source === "skill").map((c) => ({ ...c, name: stripSkillPrefix(c.name) })),
    [commands]
  );
  const skillToken = useMemo(() => {
    if (!trigger || trigger.kind !== "skill") return null;
    return trigger;
  }, [trigger]);
  const skillMatches = useMemo(
    () =>
      skillToken && skillToken.query !== dismissedSkill
        ? rankCommands(skillCommands, skillToken.query, 8)
        : [],
    [skillToken, skillCommands, dismissedSkill]
  );

  useEffect(() => setSelectedCommand(0), [commandToken]);
  useEffect(() => setSelectedMention(0), [mentionToken?.query]);
  useEffect(() => setSelectedSkill(0), [skillToken?.query]);

  const refocusEnd = () => {
    requestAnimationFrame(() => {
      const textarea = composerRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  };

  const chooseCommand = (command: CommandInfo) => {
    setText(insertCommand(command));
    setDismissedToken(null);
    refocusEnd();
  };

  const chooseSkill = (command: CommandInfo) => {
    if (!skillToken) return;
    const next = `${text.slice(0, skillToken.rangeStart)}$${command.name} ${text.slice(skillToken.rangeEnd)}`;
    setText(next);
    setDismissedSkill(null);
    refocusEnd();
  };

  const chooseMention = (bot: Bot) => {
    if (!mentionToken) return;
    const next = `${text.slice(0, mentionToken.rangeStart)}@${botHandle(bot)} ${text.slice(mentionToken.rangeEnd)}`;
    setText(next);
    setDismissedMention(null);
    refocusEnd();
  };

  const menusOpen = commandMatches.length > 0 || mentionMatches.length > 0 || skillMatches.length > 0;
  useEffect(() => {
    if (!menusOpen) return;
    const onResize = () => setMenuLayoutTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [menusOpen]);
  // Anchored above the composer; measured every render while open so textarea
  // autogrow keeps it glued. Portaled out of the session footer (which clips
  // upward-opening surfaces). Fixed z-60 sits above chat content but below
  // modal surfaces (palette, popovers, toasts at z-70).
  const menuPortal: ReactNode = (() => {
    if (!menusOpen) return null;
    const rect = menuAnchorRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return createPortal(
      <div
        style={{
          position: "fixed",
          left: rect.left,
          width: rect.width,
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
          zIndex: 60,
        }}
      >
        <CommandMenu commands={commandMatches} selected={selectedCommand} onSelect={setSelectedCommand} onChoose={chooseCommand} />
        <BotMentionMenu bots={mentionMatches} selected={selectedMention} onSelect={setSelectedMention} onChoose={chooseMention} />
        <CommandMenu commands={skillMatches} selected={selectedSkill} onSelect={setSelectedSkill} onChoose={chooseSkill} sigil="$" listId="composer-skills" optionIdPrefix="skill-opt" label="Skills" />
      </div>,
      document.body
    );
  })();

  const clearDismissals = () => {
    setDismissedToken(null);
    setDismissedMention(null);
    setDismissedSkill(null);
  };

  const handleMenuKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (mentionMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSelectedMention((index) => (e.key === "ArrowDown" ? (index + 1) % mentionMatches.length : (index - 1 + mentionMatches.length) % mentionMatches.length));
      return true;
    }
    if (commandMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSelectedCommand((index) => (e.key === "ArrowDown" ? (index + 1) % commandMatches.length : (index - 1 + commandMatches.length) % commandMatches.length));
      return true;
    }
    if (skillMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSelectedSkill((index) => (e.key === "ArrowDown" ? (index + 1) % skillMatches.length : (index - 1 + skillMatches.length) % skillMatches.length));
      return true;
    }
    if (mentionMatches.length && e.key === "Escape") {
      e.preventDefault();
      setDismissedMention(mentionToken?.query ?? "");
      return true;
    }
    if (commandMatches.length && e.key === "Escape") {
      e.preventDefault();
      setDismissedToken(commandToken);
      return true;
    }
    if (skillMatches.length && e.key === "Escape") {
      e.preventDefault();
      setDismissedSkill(skillToken?.query ?? "");
      return true;
    }
    if (mentionMatches.length && e.key === "Tab") {
      e.preventDefault();
      chooseMention(mentionMatches[selectedMention] ?? mentionMatches[0]);
      return true;
    }
    if (commandMatches.length && e.key === "Tab") {
      e.preventDefault();
      chooseCommand(commandMatches[selectedCommand] ?? commandMatches[0]);
      return true;
    }
    if (skillMatches.length && e.key === "Tab") {
      e.preventDefault();
      chooseSkill(skillMatches[selectedSkill] ?? skillMatches[0]);
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (mentionMatches.length) {
        const selected = mentionMatches[selectedMention] ?? mentionMatches[0];
        if (selected && mentionToken && `@${botHandle(selected)}` !== `@${mentionToken.query}`) chooseMention(selected);
        else return false;
        return true;
      }
      if (skillMatches.length) {
        const selected = skillMatches[selectedSkill] ?? skillMatches[0];
        if (selected && skillToken && `$${selected.name}` !== `$${skillToken.query}`) chooseSkill(selected);
        else return false;
        return true;
      }
      const selected = commandMatches[selectedCommand] ?? commandMatches[0];
      if (selected && commandToken !== selected.name) chooseCommand(selected);
      else return false;
      return true;
    }
    return false;
  };

  return {
    commandMatches,
    mentionMatches,
    skillMatches,
    skillCommands,
    menusOpen,
    menuPortal,
    clearDismissals,
    handleMenuKey,
    // Accessibility wiring for the input: which menu is open and which row
    // is highlighted (same priority as the rendered controls).
    openMenu: commandMatches.length
      ? ({ id: "composer-commands", optionIdPrefix: "cmd-opt", selected: selectedCommand } as const)
      : mentionMatches.length
        ? ({ id: "composer-bot-mentions", optionIdPrefix: "mention-opt", selected: selectedMention } as const)
        : skillMatches.length
          ? ({ id: "composer-skills", optionIdPrefix: "skill-opt", selected: selectedSkill } as const)
          : null,
  };
}
