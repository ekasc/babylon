import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/**
 * Native right-click menu contents (Electron `webContents` context-menu).
 *
 * - Editable text (composer, inputs, dialogs): the standard Cut/Copy/Paste/
 *   Select All set, enabled from the event's edit flags.
 * - A text selection elsewhere (transcript, diffs, tool output): Copy.
 * - Empty chrome: no menu at all — right-clicking buttons and blank canvas
 *   should stay quiet.
 * - Dev builds append Inspect Element.
 *
 * Regions with their own React menu (sidebar session rows) call
 * preventDefault on the DOM event, which suppresses the browser menu
 * request, so the two systems never double up.
 */
export function buildContextMenuTemplate(
  params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags" | "x" | "y">,
  isPackaged: boolean,
  hooks?: { inspectAt?: (x: number, y: number) => void }
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    const flags = params.editFlags;
    items.push(
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: "Select All" }
    );
  } else if (params.selectionText.trim().length > 0) {
    items.push({ role: "copy" });
  } else {
    return items;
  }
  if (!isPackaged) {
    const inspect = hooks?.inspectAt;
    const { x, y } = params;
    items.push(
      { type: "separator" },
      { label: "Inspect Element", click: inspect ? () => inspect(x, y) : undefined }
    );
  }
  return items;
}
