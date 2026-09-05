import { memo } from "react";
import type { CommandInfo } from "../bridge";

const SOURCE_LABEL: Record<CommandInfo["source"], string> = {
  extension: "ext",
  prompt: "prompt",
  skill: "skill",
};

interface Props {
  commands: CommandInfo[];
  selected: number;
  onSelect(index: number): void;
  onChoose(command: CommandInfo): void;
  /** Display sigil before the command name (`/` default, `$` for skill mentions). */
  sigil?: string;
  /** Listbox id override for aria-controls wiring (default `composer-commands`). */
  listId?: string;
  /** Option id prefix override for aria-activedescendant wiring. */
  optionIdPrefix?: string;
  /** Listbox aria-label override (default `Slash commands`). */
  label?: string;
}

const CommandMenu = memo(function CommandMenu({ commands, selected, onSelect, onChoose, sigil = "/", listId = "composer-commands", optionIdPrefix = "cmd-opt", label = "Slash commands" }: Props) {
  if (!commands.length) return null;
  return (
    <div
      id={listId}
      role="listbox"
      aria-label={label}
      className="max-h-72 overflow-y-auto rounded-lg border border-line bg-raised p-1.5 shadow-2xl"
    >
      {commands.map((command, index) => (
        <button
          id={`${optionIdPrefix}-${index}`}
          key={`${command.source}:${command.name}`}
          role="option"
          aria-selected={index === selected}
          onMouseEnter={() => onSelect(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(command)}
          className={`flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left ${index === selected ? "bg-accent-soft" : "hover:bg-inset"}`}
        >
          <span className="shrink-0 font-mono text-[14px] font-semibold text-accent">{sigil}{command.name}</span>
          {command.argumentHint ? <span className="shrink-0 font-mono text-[13px] text-warn">{command.argumentHint}</span> : null}
          <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{command.description}</span>
          <span className="shrink-0 text-[12px] text-dim">{SOURCE_LABEL[command.source]}</span>
        </button>
      ))}
    </div>
  );
});

export default CommandMenu;
