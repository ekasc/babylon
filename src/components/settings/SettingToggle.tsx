import { Checkbox } from "../ui/Checkbox";

export function SettingToggle({
  label,
  checked,
  onChange,
  ariaLabel,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <label
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onChange(!checked);
      }}
      className="flex items-center justify-between rounded-[var(--radius-sm)] px-3 py-2.5 hover:bg-inset cursor-pointer border border-transparent hover:border-line/30"
    >
      <span className="text-[13px]">{label}</span>
      <Checkbox checked={checked} onChange={onChange} ariaLabel={ariaLabel ?? label} />
    </label>
  );
}
