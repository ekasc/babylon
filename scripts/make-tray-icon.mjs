// Generates the macOS menu-bar glyph: a rounded-square tile outline with a
// center node dot. Black with alpha, used as a template image (the system
// inverts it on dark menu bars). Prints a base64 data URL for electron/tray.ts
// and writes a preview PNG next to it for eyeballing.
// Run: node scripts/make-tray-icon.mjs [--preview-only]
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const GRID = 64;
const OUT = 32;

const TILE = { x0: 12, y0: 12, x1: 52, y1: 52, r: 10, stroke: 5.5 };
const DOT = { cx: 32, cy: 32, r: 6.5 };

function insideRR(x, y, x0, y0, x1, y1, r) {
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function alphaAt(x, y) {
  const onTile =
    insideRR(x, y, TILE.x0, TILE.y0, TILE.x1, TILE.y1, TILE.r) &&
    !insideRR(
      x,
      y,
      TILE.x0 + TILE.stroke,
      TILE.y0 + TILE.stroke,
      TILE.x1 - TILE.stroke,
      TILE.y1 - TILE.stroke,
      Math.max(1, TILE.r - TILE.stroke)
    );
  const dx = x - DOT.cx;
  const dy = y - DOT.cy;
  const onDot = dx * dx + dy * dy <= DOT.r * DOT.r;
  return onTile || onDot ? 255 : 0;
}

// 2x2 box average down to OUT pixels.
const px = Buffer.alloc(OUT * OUT * 4);
for (let oy = 0; oy < OUT; oy++) {
  for (let ox = 0; ox < OUT; ox++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (alphaAt(ox * 2 + (i + 0.5) / 2, oy * 2 + (j + 0.5) / 2)) sum++;
      }
    }
    const a = Math.round((sum / 16) * 255);
    const o = (oy * OUT + ox) * 4;
    px[o] = 0;
    px[o + 1] = 0;
    px[o + 2] = 0;
    px[o + 3] = a;
  }
}

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  px.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(join(tmpdir(), "babylon-tray-preview.png"), png);
if (!process.argv.includes("--preview-only")) {
  console.log(`data:image/png;base64,${png.toString("base64")}`);
}
