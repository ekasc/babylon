import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  KNOWN_MESSAGE_TYPES,
  parseEnvelope,
  serializeEnvelope,
  type ProtocolEnvelope,
} from "./daemon-protocol";

describe("babylon daemon protocol", () => {
  it("creates a well-formed envelope with a stable id and timestamp", () => {
    const e = createEnvelope("event", "task.created", { taskId: "t1" });
    expect(e.id.length).toBeGreaterThan(0);
    expect(e.kind).toBe("event");
    expect(e.type).toBe("task.created");
    expect(Number.isFinite(e.ts)).toBe(true);
    expect(e.inReplyTo).toBeUndefined();
  });

  it("round-trips through serialize/parse", () => {
    const e = createEnvelope("response", "pong", null, "req-1");
    const parsed = parseEnvelope(serializeEnvelope(e));
    expect(parsed.id).toBe(e.id);
    expect(parsed.inReplyTo).toBe("req-1");
    expect(parsed.type).toBe("pong");
  });

  it("rejects null or array input", () => {
    expect(() => parseEnvelope("null")).toThrow(/not an object/);
    expect(() => parseEnvelope("[]")).toThrow(/not an object/);
  });

  it("rejects a missing or empty stable id", () => {
    expect(() => parseEnvelope(JSON.stringify({ kind: "event", type: "ping", ts: 1 }))).toThrow(
      /stable id/
    );
    expect(() =>
      parseEnvelope(JSON.stringify({ id: "", kind: "event", type: "ping", ts: 1 }))
    ).toThrow(/stable id/);
  });

  it("rejects a bad kind", () => {
    expect(() =>
      parseEnvelope(JSON.stringify({ id: "m1", kind: "notify", type: "ping", ts: 1 }))
    ).toThrow(/bad kind/);
  });

  it("rejects an unknown message type", () => {
    expect(() =>
      parseEnvelope(JSON.stringify({ id: "m1", kind: "event", type: "bogus.op", ts: 1 }))
    ).toThrow(/unknown type/);
  });

  it("rejects a non-finite timestamp", () => {
    expect(() =>
      parseEnvelope(JSON.stringify({ id: "m1", kind: "event", type: "ping", ts: NaN }))
    ).toThrow(/ts/);
  });

  it("rejects a malformed inReplyTo", () => {
    expect(() =>
      parseEnvelope(
        JSON.stringify({ id: "m1", kind: "response", type: "pong", ts: 1, inReplyTo: "" })
      )
    ).toThrow(/inReplyTo/);
  });

  it("knows all well-known message types", () => {
    expect(KNOWN_MESSAGE_TYPES.length).toBeGreaterThanOrEqual(17);
  });
});
