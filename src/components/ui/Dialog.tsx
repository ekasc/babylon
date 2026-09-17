import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";

/**
 * Babylon modal wrapper over Base UI Dialog.
 *
 * Base UI owns: initial focus, Tab trapping, Escape, outside-press
 * dismissal, focus restoration, ARIA semantics, portal behavior.
 * Babylon owns: all styling classes, layout, z-index, copy.
 *
 * Conditionally-mounted usage (matches how App.tsx renders surfaces):
 *   {open && <ModalDialog onClose={...} ... />}
 * so `open` defaults to true and `onClose` fires for any allowed dismiss.
 *
 * Set `dismissible={false}` for surfaces that must not close on
 * Escape/outside-press (approval gates, busy destructive flows). The
 * `onClose` handler (e.g. explicit Cancel buttons) still works.
 */
export function ModalDialog({
  open = true,
  onClose,
  dismissible = true,
  backdropClassName,
  viewportClassName,
  popupClassName,
  ariaLabel,
  ariaLabelledBy,
  initialFocus,
  popupRef,
  children,
}: {
  open?: boolean;
  onClose(): void;
  dismissible?: boolean;
  backdropClassName: string;
  viewportClassName: string;
  popupClassName: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  initialFocus?: React.RefObject<HTMLElement | null>;
  popupRef?: React.RefCallback<HTMLDivElement> | React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        // Non-dismissible surfaces (busy, approval) ignore Escape and
        // outside-press; explicit Close/Cancel buttons still call onClose
        // directly so they keep working.
        if (!dismissible && (details.reason === "escape-key" || details.reason === "outside-press")) {
          details.cancel();
          return;
        }
        onClose();
      }}
      disablePointerDismissal={!dismissible}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropClassName} />
        <Dialog.Viewport className={viewportClassName}>
          <Dialog.Popup
            ref={popupRef}
            className={popupClassName}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            initialFocus={initialFocus}
          >
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
