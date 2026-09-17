import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { encode64, encodePlantUml } from "./plantuml";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** Inverse of encode64 via index mapping (the alphabet is a permutation). */
function decode64(s: string): Uint8Array {
  const vals = [...s].map((c) => {
    const v = ALPHABET.indexOf(c);
    if (v === -1) throw new Error(`bad char ${c}`);
    return v;
  });
  const out: number[] = [];
  for (let i = 0; i < vals.length; i += 4) {
    const n = vals.length - i;
    out.push((vals[i] << 2) | (vals[i + 1] >> 4));
    if (n > 2) out.push(((vals[i + 1] & 15) << 4) | (vals[i + 2] >> 2));
    if (n > 3) out.push(((vals[i + 2] & 3) << 6) | vals[i + 3]);
  }
  return new Uint8Array(out);
}

describe("plantuml encoding", () => {
  it("round-trips through deflate + alphabet (A08)", async () => {
    const src = "@startuml\nAlice -> Bob: héllo wörld\n@enduml";
    const encoded = await encodePlantUml(src);
    expect(encoded).toMatch(/^[0-9A-Za-z\-_]+$/);
    expect(inflateRawSync(decode64(encoded)).toString("utf8")).toBe(src);
  });

  it("packs trailing bytes without padding", () => {
    expect(encode64(new Uint8Array([0xff]))).toHaveLength(2);
    expect(encode64(new Uint8Array([0xff, 0xff]))).toHaveLength(3);
    expect(encode64(new Uint8Array([0xff, 0xff, 0xff]))).toHaveLength(4);
  });
});
