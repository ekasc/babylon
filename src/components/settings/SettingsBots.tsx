import BotsManager, { type BotsManagerProps } from "../BotsManager";

export function SettingsBots({ manager }: { manager: BotsManagerProps }) {
  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Bots</h2>
      <p className="text-[13px] leading-5 text-dim mt-1">
        Named specialists, each with a canonical chat. This project's team decides who shows up in rooms.
      </p>
      <div className="mt-4">
        <BotsManager {...manager} />
      </div>
    </div>
  );
}
