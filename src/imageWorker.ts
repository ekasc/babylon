// Off-thread image resize via OffscreenCanvas — keeps Composer 60fps
// Falls back to main-thread canvas if OffscreenCanvas unavailable
self.onmessage = async (e: MessageEvent) => {
  const { id, blob, maxEdge } = e.data as { id: number; blob: Blob; maxEdge: number };
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      (self as any).postMessage({ id, ok: true, blob });
      bitmap.close();
      return;
    }
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    let outBlob: Blob;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) throw new Error("offscreen ctx");
      ctx.drawImage(bitmap, 0, 0, w, h);
      outBlob = await canvas.convertToBlob({ type: blob.type === "image/png" ? "image/png" : "image/jpeg", quality: 0.85 });
    } else {
      // Fallback: not used (main thread will handle), but keep for completeness
      throw new Error("no OffscreenCanvas");
    }
    bitmap.close();
    (self as any).postMessage({ id, ok: true, blob: outBlob });
  } catch (err: any) {
    (self as any).postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};
