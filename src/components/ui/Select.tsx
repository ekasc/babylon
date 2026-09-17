import { Children, Fragment, isValidElement, useMemo, type ReactNode } from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { ChevronIcon } from "../icons";

/**
 * Babylon select over Base UI Select.
 *
 * Base UI owns: open state, trigger semantics, listbox keyboard
 * (arrows/type-ahead/Enter/Escape), outside-press dismissal, option
 * roles, focus return.
 * Babylon owns: all styling classes. The trigger keeps whatever classes
 * the caller passed (e.g. `settings-input`); the dropdown speaks the
 * `.thread-menu` row language.
 *
 * Labels may differ from values (like native `<option>`):
 *   <Select value={provider} onChange={setProvider} triggerClassName="settings-input w-[200px]">
 *     <SelectOption value="all" label="All providers" />
 *     {providers.map((p) => <SelectOption key={p} value={p}>{p}</SelectOption>)}
 *   </Select>
 *
 * Options must be <SelectOption> children (fragments allowed) so labels resolve.
 */
export function SelectOption({
  value,
  label,
  children,
}: {
  value: string;
  label?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <BaseSelect.Item
      value={value}
      className="thread-menu-item data-[selected]:font-medium data-[selected]:text-accent"
    >
      <span className="min-w-0 flex-1 truncate">{children ?? label ?? value}</span>
    </BaseSelect.Item>
  );
}

export function Select({
  value,
  onChange,
  disabled,
  placeholder,
  triggerClassName,
  popupClassName,
  align = "start",
  sideOffset = 4,
  ariaLabel,
  title,
  children,
}: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  placeholder?: ReactNode;
  triggerClassName?: string;
  popupClassName?: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
  ariaLabel?: string;
  title?: string;
  children: ReactNode;
}) {
  const labels = useMemo(() => {
    const map = new Map<string, ReactNode>();
    const walk = (nodes: ReactNode): void => {
      Children.forEach(nodes, (c) => {
        if (!isValidElement(c)) return;
        if (c.type === SelectOption) {
          const p = c.props as { value: string; label?: ReactNode; children?: ReactNode };
          map.set(p.value, p.label ?? p.children ?? p.value);
        } else if (c.type === Fragment) {
          walk((c.props as { children?: ReactNode }).children);
        }
      });
    };
    walk(children);
    return map;
  }, [children]);

  return (
    <BaseSelect.Root value={value} onValueChange={(next) => onChange(next as string)} disabled={disabled}>
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        title={title}
        className={`${triggerClassName ?? ""} flex items-center gap-1.5`}
      >
        <BaseSelect.Value placeholder={placeholder}>
          {(v: string | null) => (
            <span className="min-w-0 flex-1 truncate text-left">
              {v != null ? (labels.get(v) ?? v) : placeholder}
            </span>
          )}
        </BaseSelect.Value>
        <BaseSelect.Icon>
          <ChevronIcon size={10} className="shrink-0 text-dim" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          side="bottom"
          align={align}
          sideOffset={sideOffset}
          alignItemWithTrigger={false}
          collisionAvoidance={{ side: "flip", align: "flip" }}
          className="z-50"
        >
          <BaseSelect.Popup
            className={`thread-menu max-h-[320px] overflow-y-auto p-1.5 ${popupClassName ?? ""}`}
          >
            <BaseSelect.List>{children}</BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
