import { Switch as BaseSwitch } from "@base-ui/react/switch";

/**
 * Babylon switch over Base UI Switch.
 *
 * Base UI owns: checked state, Space/Enter activation, focus visibility,
 * ARIA switch semantics, disabled handling.
 * Babylon owns: all styling classes — the track/knob geometry matches the
 * hand-rolled daemon toggle this replaces, pixel for pixel.
 *
 *   <Switch checked={enabled} onChange={setEnabled} aria-label="…" />
 */
export function Switch({
  checked,
  onChange,
  disabled,
  ariaLabel,
  className = "",
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-line/60 transition-colors data-[checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <BaseSwitch.Thumb className="ml-0.5 block h-4 w-4 rounded-full bg-bg shadow transition-transform data-[checked]:translate-x-4" />
    </BaseSwitch.Root>
  );
}
