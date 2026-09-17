// PlantUML URL encoding: raw DEFLATE of the UTF-8 source, then the
// PlantUML 64-character alphabet (NOT standard base64: no padding, `-_`
// instead of `+/`). Verified by round-tripping through zlib in tests.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

export function encode64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += ALPHABET[b1 >> 2];
    out += ALPHABET[((b1 & 0x03) << 4) | (b2 >> 4)];
    if (i + 1 < data.length) out += ALPHABET[((b2 & 0x0f) << 2) | (b3 >> 6)];
    if (i + 2 < data.length) out += ALPHABET[b3 & 0x3f];
  }
  return out;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encode diagram source for `https://www.plantuml.com/plantuml/svg/<out>`. */
export async function encodePlantUml(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === "undefined" || typeof Blob === "undefined") {
    throw new Error("deflate unavailable in this runtime");
  }
  return encode64(await deflateRaw(bytes));
}
