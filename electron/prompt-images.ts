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
