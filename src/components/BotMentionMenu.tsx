import { memo } from "react";
import type { Bot } from "../bots";
import { botHandle } from "../bots";
import { BotAvatar } from "./BotsPanel";

interface Props {
  bots: Bot[];
  selected: number;
  onSelect(index: number): void;
  onChoose(bot: Bot): void;
}

const BotMentionMenu = memo(function BotMentionMenu({ bots, selected, onSelect, onChoose }: Props) {
  if (!bots.length) return null;
  return (
    <div
      id="composer-bot-mentions"
      role="listbox"
      aria-label="Mention a bot"
      className="max-h-72 overflow-y-auto rounded-lg border border-line bg-raised p-1.5 shadow-2xl"
    >
      {bots.map((bot, index) => (
        <button
          id={`mention-opt-${index}`}
          key={bot.id}
          role="option"
          aria-selected={index === selected}
          onMouseEnter={() => onSelect(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(bot)}
          className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left ${index === selected ? "bg-accent-soft" : "hover:bg-inset"}`}
        >
          <BotAvatar name={bot.name} size={20} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">@{botHandle(bot)}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{bot.title ?? bot.name}</span>
        </button>
      ))}
    </div>
  );
});

export default BotMentionMenu;
