import { useEffect, useRef } from "react";

/**
 * Shared modal dialog behavior: focus the first control on open, trap Tab,
 * restore focus on unmount, and close on Escape when an `onClose` is given
 * (dialogs without a dismiss action, like approval gates, omit it). Same
 * pattern as DialogHost and Rollback; pair with role="dialog" + aria-modal +
 * aria-labelledby on the element that receives `ref`.
 */
export function useModalDialog(onClose?: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => {
      const focusable = ref.current?.querySelector<HTMLElement>(
        "button, input, textarea, select, [tabindex]:not([tabindex='-1'])"
      );
      focusable?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onCloseRef.current) onCloseRef.current();
      if (e.key === "Tab" && ref.current) {
        const focusable = [
          ...ref.current.querySelectorAll<HTMLElement>(
            "button, input, textarea, select, [tabindex]:not([tabindex='-1'])"
          ),
        ];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, []);

  return ref;
}
