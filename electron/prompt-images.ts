import type { ModelRef } from "../src/lib/settings-shared";
import { modelSupportsImages } from "./snapcompact/model-profiles";

export interface RendererImage {
  data: string;
  mimeType?: string;
}

/** Normalize the renderer payload to the flat ImageContent shape expected by pi-ai. */
export function toPiImages(images?: RendererImage[]): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  if (!images?.length) return undefined;
  return images.map((image) => ({
    type: "image",
    data: image.data,
    mimeType: image.mimeType ?? "image/png",
  }));
}

/** Decide whether attached images are routed through the configured image
 *  model instead of attaching them directly: only when an image model is set
 *  AND the session's chat model has no vision (a vision-capable chat model
 *  keeps the raw images, where it can read them with full fidelity). */
export function shouldRelayImagesThrough(
  imageModel: ModelRef | undefined,
  sessionModel: { supportsImages?: boolean; vision?: boolean; input?: string[] } | null | undefined
): boolean {
  if (!imageModel) return false;
  const vision = modelSupportsImages(sessionModel ?? undefined) || !!sessionModel?.supportsImages || !!sessionModel?.vision;
  return !vision;
}