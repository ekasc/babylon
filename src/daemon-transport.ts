// Frame codec for the Babylon daemon's local transport (Phase 6, Feature 13).
//
// Frames are newline-delimited JSON over a byte stream. A serialized envelope
// never contains a raw newline, so "\n" is an unambiguous delimiter. The
// decoder reassembles multi-byte UTF-8 characters split across TCP chunks via
// StringDecoder, enforces a maximum frame size so a buggy or hostile peer
// cannot exhaust memory, and ignores blank lines.

import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export interface FrameDecoder {
  /** Feed one chunk; returns every complete frame it completed. */
  push(chunk: Buffer | string): string[];
}

export function createFrameDecoder(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES): FrameDecoder {
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new Error("maxFrameBytes must be a positive integer");
  }
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return {
    push(chunk) {
      buffer += decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      const frames: string[] = [];
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > maxFrameBytes) {
          throw new Error(`frame exceeds ${maxFrameBytes} bytes`);
        }
        if (line.trim().length > 0) frames.push(line);
      }
      // An unterminated partial frame is bounded too, so a peer that streams
      // bytes without ever sending a newline cannot grow memory unbounded.
      if (buffer.length > maxFrameBytes) {
        throw new Error(`frame exceeds ${maxFrameBytes} bytes`);
      }
      return frames;
    },
  };
}

/** Wrap one serialized envelope as a transmittable frame. */
export function encodeFrame(json: string): string {
  if (json.includes("\n")) {
    throw new Error("frame payload must not contain a newline");
  }
  return json + "\n";
}
