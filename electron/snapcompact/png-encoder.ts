// Minimal pure-JS PNG encoder for Snapcompact frames.
//
// Produces a monochrome (color type 0, bit depth 1) PNG. The image is
// `1`-background / `0`-foreground so dark text on a white background is
// what an OCR pipeline expects.
//
// No native dependencies, no third-party libraries. CRC32 uses the
// standard PNG polynomial (0xEDB88320) computed in a single 256-entry
// table at module load.

import { deflateSync } from "node:zlib";

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crc = crc32(concat(typeBytes, data));
  return concat(u32be(data.length), typeBytes, data, u32be(crc));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

const SIG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Encode a 1-bit monochrome bitmap as a PNG. `pixels` is row-major;
 *  pixel (x, y) is at bit (y*rowBytes*8 + x), MSB-first per byte, 0=black. */
export function encodePng1Bit(width: number, height: number, pixels: Uint8Array): Buffer {
  if (!Number.isInteger(width) || width <= 0) throw new Error("png: bad width");
  if (!Number.isInteger(height) || height <= 0) throw new Error("png: bad height");
  const rowBytes = Math.ceil(width / 8);
  const expected = rowBytes * height;
  if (pixels.length !== expected) throw new Error(`png: pixel buffer size ${pixels.length} != expected ${expected}`);

  // Build raw scanlines with filter byte 0 (None) per scanline.
  const raw = new Uint8Array(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + rowBytes)] = 0;
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (1 + rowBytes) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  const ihdr = concat(
    u32be(width),
    u32be(height),
    new Uint8Array([1, 0, 0, 0, 0]),
  );
  return Buffer.from(concat(
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ));
}

/** Draw a 1-bit bitmap of size width*height into the pixel buffer.
 *  Set a pixel to foreground (0=black) or background (1=white). */
export function fillRect(
  pixels: Uint8Array, width: number, height: number,
  x0: number, y0: number, w: number, h: number, on: boolean,
): void {
  const value = on ? 0 : 1;
  for (let dy = 0; dy < h; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = 0; dx < w; dx++) {
      const x = x0 + dx;
      if (x < 0 || x >= width) continue;
      const byte = (y * Math.ceil(width / 8)) + (x >> 3);
      const bit = 0x80 >>> (x & 7);
      if (value === 0) pixels[byte] &= ~bit & 0xFF;
      else pixels[byte] |= bit;
    }
  }
}
