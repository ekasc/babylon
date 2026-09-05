import type { Bot } from "../../bots";
import { BotAvatar } from "../BotsPanel";
import { SettingSection } from "./SettingSection";

interface Props {
  bots: Bot[];
  defaultBotName: string | null;
  emptyHint?: string;
  onOpenBot(bot: Bot): void;
  onManageBots(): void;
  onOpenProject(): void;
}

export function SettingsBots({ bots, defaultBotName, emptyHint, onOpenBot, onManageBots, onOpenProject }: Props) {
  const visible = bots.filter((b) => !b.hidden);
  return (
    <div>
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Bots</h2>
      <p className="text-[15px] leading-6 text-fg/60 mt-2">Named specialists with a canonical forever-chat each. Open one to resume its chat.</p>

      <SettingSection title="Team" hint="Staffed from project settings. Full create, edit, and room management lives in the bot manager.">
        <div className="rounded-md border border-line/30 overflow-hidden divide-y divide-line/20 max-w-[720px]">
          {defaultBotName ? (
            <button
              type="button"
              onClick={onOpenProject}
              title="Project settings, default bot, team, free discussion"
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-inset"
            >
              <BotAvatar name={defaultBotName} size={20} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-[550]">{defaultBotName}</span>
                <span className="block truncate text-[12.5px] text-dim">default · this project</span>
              </span>
            </button>
          ) : null}
          {visible.length === 0 && !defaultBotName ? (
            <p className="px-4 py-4 text-[13px] leading-6 text-dim">
              {emptyHint ?? "No bots yet."}{" "}
              <button type="button" onClick={onOpenProject} className="font-semibold text-accent hover:underline">
                Add teammates
              </button>
            </p>
          ) : (
            visible.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => onOpenBot(bot)}
                title={bot.description ?? `Open ${bot.name}'s chat`}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-inset"
              >
                <BotAvatar name={bot.name} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-[550]">{bot.name}</span>
                  {bot.title ? <span className="block truncate text-[12.5px] text-dim">{bot.title}</span> : null}
                </span>
                {bot.mainSessionFile || (bot.sessionsByProject && Object.keys(bot.sessionsByProject).length > 0) ? <span title="Has a chat" className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" /> : null}
              </button>
            ))
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={onManageBots} className="rounded-md border border-line px-3 py-1.5 text-[12.5px] hover:bg-inset">Manage bots…</button>
        </div>
      </SettingSection>
    </div>
  );
}
