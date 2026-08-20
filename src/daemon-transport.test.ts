import { describe, expect, it } from "vitest";
import { createFrameDecoder, DEFAULT_MAX_FRAME_BYTES, encodeFrame } from "./daemon-transport";

describe("daemon transport framing", () => {
  it("splits newline-delimited frames", () => {
    const d = createFrameDecoder();
    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("reassembles frames split across chunks", () => {
    const d = createFrameDecoder();
    expect(d.push('{"a"')).toEqual([]);
    expect(d.push(':1}\n{"b"')).toEqual(['{"a":1}']);
    expect(d.push(':2}\n')).toEqual(['{"b":2}']);
  });

  it("reassembles multi-byte UTF-8 split mid-character", () => {
    const d = createFrameDecoder();
    // "é" is two bytes (0xC3 0xA9). Split between them.
    const bytes = Buffer.from('{"s":"é"}\n', "utf8");
    const splitAt = bytes.indexOf(0xa9);
    expect(d.push(bytes.subarray(0, splitAt))).toEqual([]);
    expect(d.push(bytes.subarray(splitAt))).toEqual(['{"s":"é"}']);
  });

  it("ignores blank lines and returns nothing for a partial frame", () => {
    const d = createFrameDecoder();
    expect(d.push("\n\n")).toEqual([]);
    expect(d.push("x")).toEqual([]);
  });

  it("throws when a complete frame exceeds the limit", () => {
    const d = createFrameDecoder(8);
    expect(() => d.push("123456789\n")).toThrow(/exceeds 8 bytes/);
  });

  it("throws when an unterminated partial frame exceeds the limit", () => {
    const d = createFrameDecoder(8);
    expect(() => d.push("123456789")).toThrow(/exceeds 8 bytes/);
  });

  it("keeps working after a frame that fits exactly", () => {
    const d = createFrameDecoder(DEFAULT_MAX_FRAME_BYTES);
    const big = "x".repeat(DEFAULT_MAX_FRAME_BYTES);
    expect(d.push(big + "\n")).toEqual([big]);
  });

  it("rejects a non-positive or non-integer limit", () => {
    expect(() => createFrameDecoder(0)).toThrow(/positive integer/);
    expect(() => createFrameDecoder(1.5)).toThrow(/positive integer/);
  });

  it("encodes by appending a newline and rejects embedded newlines", () => {
    expect(encodeFrame("{}")).toBe("{}\n");
    expect(() => encodeFrame("{}\n")).toThrow(/newline/);
  });
});
