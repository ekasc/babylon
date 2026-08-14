// Palette search worker. Runs every keystroke's scan off the main thread so
// typing stays at 60fps even with thousands of sessions. The Worker is created
// with `new Worker(new URL(...), { type: "module" })` from CommandPalette; in
// production (file:// origin) module workers cannot be constructed, so the
// palette falls back to the identical inline path. That fallback is why this
// file must stay import-free of anything with runtime side effects.
import { buildPaletteIndex, searchPalette, type PaletteIndex } from "./paletteSearch";

let index: PaletteIndex = { sessions: [], commands: [] };

self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "index": {
      index = buildPaletteIndex(message.groups ?? [], message.commands ?? []);
      break;
    }
    case "query": {
      const results = searchPalette(index, message.query ?? "");
      self.postMessage({ type: "results", id: message.id, results });
      break;
    }
  }
};
