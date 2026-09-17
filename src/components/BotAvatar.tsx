import { botAvatarHue, botInitials } from "../bots";

export function BotAvatar({ name, size = 22 }: { name: string; size?: number }) {
  const hue = botAvatarHue(name);
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.42)),
        backgroundColor: `hsl(${hue} 55% 42%)`,
      }}
    >
      {botInitials(name)}
    </span>
  );
}
