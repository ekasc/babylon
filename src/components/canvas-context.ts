import { createContext, useContext } from "react";

/**
 * How a diagram in the conversation reaches the canvas. A context rather than a
 * prop so that Markdown can offer "open in canvas" without threading a callback
 * through every layer that renders message content.
 */
export type CanvasOpener = { openInCanvas(code: string): void };

const CanvasContext = createContext<CanvasOpener | null>(null);

export const CanvasProvider = CanvasContext.Provider;

export function useCanvasOpener(): CanvasOpener | null {
  return useContext(CanvasContext);
}
