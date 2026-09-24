import type { ReactNode } from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";

/**
 * Babylon anchored popover over Base UI Popover.
 *
 * Base UI owns: open state wiring, trigger semantics (aria-expanded,
 * aria-haspopup), outside-press dismissal, Escape, initial focus.
 * Babylon owns: all styling classes, placement geometry, portal choice.
 *
 * Placement is deliberately pixel-stable, matching the hand-rolled
 * surfaces this replaces:
 *
 * - Inline mode (`container` = the trigger's positioned ancestor, which
 *   the pickers already hold in a ref): coordinates resolve against that
 *   ancestor via `positionMethod="absolute"` (fixed positioning would
 *   re-anchor under backdrop-filter chrome and move pixels).
 * - Body-portal mode (`container` omitted): `positionMethod="fixed"`,
 *   for panels that must escape clipping ancestors (the composer footer
 *   stacking context). Same numbers the manual getBoundingClientRect
 *   placement produced.
 * - Collision avoidance OFF (`side`/`align: 'none'`) in both modes: the
 *   panel never flips or shifts; it opens exactly where asked.
 *
 * The container must be set before opening, which holds for click-opened
 * surfaces (the panel only mounts on open).
 *
 * Listbox keyboard (arrows/type-ahead), autofocus targets, and any
 * backdrop live in the caller — this primitive only owns dismissal.
 * Focus is never stolen on open (initialFocus defaults to false):
 * Babylon focuses its own targets explicitly, and popup focus-steal
 * scrolls the page to the freshly mounted panel.
 *
 *   <div ref={rootRef} className="relative">
 *     <PopoverRoot open={open} onOpenChange={setOpen}>
 *       <PopoverTrigger className="…">…</PopoverTrigger>
 *       <PopoverPanel container={rootRef.current} side="bottom" align="start" sideOffset={8} className="operator-popover absolute …">
 *         …
 *       </PopoverPanel>
 *     </PopoverRoot>
 *   </div>
 */
export function PopoverRoot({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  return (
    <BasePopover.Root open={open} onOpenChange={(next) => onOpenChange(next)} modal={false}>
      {children}
    </BasePopover.Root>
  );
}

export const PopoverTrigger = BasePopover.Trigger;

export function PopoverPanel({
  container,
  side = "bottom",
  align = "start",
  sideOffset = 8,
  matchTriggerWidth = true,
  positionerClassName,
  className,
  initialFocus = false,
  collisionAvoidance = { side: "none", align: "none" },
  children,
}: {
  /** Positioned ancestor to portal into. Omit for a body portal. */
  container?: HTMLElement | null;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** Size the panel to the trigger width (default true). Explicit width
   *  classes on the panel still win. */
  matchTriggerWidth?: boolean;
  /** Collision response. Default pins the preferred placement (pixel
   *  stability for anchored pickers). Pass `{ side: "none", align: "shift" }`
   *  for viewport-edge panels that must slide into view instead. */
  collisionAvoidance?: { side?: "none"; align?: "flip" | "shift" | "none" } | { side: "shift"; align?: "shift" | "none" };
  positionerClassName?: string;
  className?: string;
  initialFocus?: boolean | React.RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <BasePopover.Portal container={container}>
      <BasePopover.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        positionMethod={container ? "absolute" : "fixed"}
        collisionAvoidance={collisionAvoidance}
        className={positionerClassName}
        style={matchTriggerWidth ? { width: "var(--anchor-width)" } : undefined}
      >
        <BasePopover.Popup className={className} initialFocus={initialFocus}>
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
