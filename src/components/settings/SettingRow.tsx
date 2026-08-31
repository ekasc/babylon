export function SettingRow({
  title,
  description,
  control,
  onReset,
  customized,
  id,
}: {
  title: string;
  description?: string;
  control: React.ReactNode;
  onReset?: () => void;
  customized?: boolean;
  id?: string;
}) {
  return (
    <div id={id} className="group flex items-start gap-6 px-4 py-4 border-b border-white/10 last:border-0">
      <div className="w-[380px] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-[550] tracking-[-0.01em] text-white">{title}</span>
          {customized && onReset ? (
            <button
              onClick={onReset}
              title="Reset to default"
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-[11px] text-dim hover:text-fg px-1 rounded"
            >
              ↺ reset
            </button>
          ) : null}
        </div>
        {description ? <p className="mt-1 text-[13px] leading-5 text-white/55 max-w-[60ch]">{description}</p> : null}
      </div>
      <div className="flex flex-none items-center gap-2">{control}</div>
    </div>
  );
}
