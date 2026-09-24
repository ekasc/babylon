// Off-thread image resize via OffscreenCanvas — keeps Composer 60fps
// Falls back to main-thread canvas if OffscreenCanvas unavailable
import { wireOf } from "./lib/wire";
declare function postMessage(msg: unknown): void;
self.onmessage = async (e: MessageEvent) => {
  // MessageEvent.data is any by DOM typing: validate the wire shape before
  // touching it so a malformed post never throws mid-destructure.
  const data: unknown = e.data;
  const wire = wireOf(data);
  const id = typeof wire?.id === "number" ? wire.id : -1;
  const maxEdge = typeof wire?.maxEdge === "number" ? wire.maxEdge : 1280;
  const blob = wire?.blob;
  const reply = (msg: unknown) => {
    postMessage(msg);
  };
  try {
    if (!(blob instanceof Blob)) throw new Error("image worker: missing image blob");
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      reply({ id, ok: true, blob });
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
    reply({ id, ok: true, blob: outBlob });
  } catch (err: unknown) {
    reply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
