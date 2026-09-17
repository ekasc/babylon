import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckIcon } from "../icons";

/**
 * Babylon checkbox over Base UI Checkbox.
 *
 * Base UI owns: checked state, Space activation, focus visibility, ARIA
 * checkbox semantics, disabled handling.
 * Babylon owns: all styling classes — a 16px box in the token language
 * (replaces unstyled native boxes, which render OS chrome).
 *
 *   <Checkbox checked={picked} onChange={setPicked} aria-label="…" />
 */
export function Checkbox({
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
    <BaseCheckbox.Root
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border border-line-strong bg-transparent transition-colors data-[checked]:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <BaseCheckbox.Indicator className="grid place-items-center text-accent">
        <CheckIcon size={11} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
