import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  DAEMON_PROTOCOL_VERSION,
  KNOWN_MESSAGE_TYPES,
  parseEnvelope,
  serializeEnvelope,
  shouldRetireDaemon,
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
    const e = createEnvelope("response", "pong", {}, "req-1");
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
    expect(() =>
      parseEnvelope(JSON.stringify({ kind: "event", type: "ping", ts: 1 }))
    ).toThrow(/bad id type/);
    expect(() =>
      parseEnvelope(JSON.stringify({ id: "", kind: "event", type: "ping", ts: 1 }))
    ).toThrow(/missing stable id/);
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

  it("rejects a whitespace-only stable id", () => {
    expect(() =>
      parseEnvelope(JSON.stringify({ id: "   ", kind: "event", type: "ping", ts: 1 }))
    ).toThrow(/stable id/);
  });

  it("rejects malformed JSON with a wrapped error", () => {
    expect(() => parseEnvelope("{")).toThrow(/malformed JSON/);
  });

  it("createEnvelope enforces the same contract as the parser", () => {
    expect(() => createEnvelope("response", "pong", {}, "")).toThrow(/inReplyTo/);
    // Non-object payloads cannot reach createEnvelope anymore: its payload
    // parameter is object-typed, so an array or scalar is a compile error. The
    // runtime guard still covers the untrusted boundary (arbitrary JSON), which
    // the parseEnvelope case below exercises.
  });

  it("allows ping/pong without a data payload", () => {
    const e = createEnvelope("event", "ping", {});
    expect(parseEnvelope(serializeEnvelope(e)).type).toBe("ping");
  });

  it("rejects a non-object payload for data-bearing types", () => {
    expect(() =>
      parseEnvelope(
        JSON.stringify({ id: "m1", kind: "event", type: "task.created", payload: 5, ts: 1 })
      )
    ).toThrow(/payload/);
  });

  it("keeps the type union in sync with the known types list", () => {
    expect(KNOWN_MESSAGE_TYPES.length).toBe(93);
  });
});

describe("shouldRetireDaemon", () => {
  const ours = { protocol: DAEMON_PROTOCOL_VERSION, build: "abc123" };

  it("keeps an unreachable socket for the spawn path", () => {
    expect(shouldRetireDaemon(undefined, ours)).toBe(false);
  });

  it("retires on protocol mismatch", () => {
    expect(shouldRetireDaemon({ protocol: ours.protocol + 1, build: ours.build }, ours)).toBe(true);
  });

  it("keeps identical builds", () => {
    expect(shouldRetireDaemon({ protocol: ours.protocol, build: ours.build }, ours)).toBe(false);
  });

  it("retires same-version skew from separate bundle builds", () => {
    expect(shouldRetireDaemon({ protocol: ours.protocol, build: "stale00" }, ours)).toBe(true);
  });

  it("retires a daemon that predates build ids, and keeps when it cannot compare", () => {
    expect(shouldRetireDaemon({ protocol: ours.protocol }, ours)).toBe(true);
    expect(shouldRetireDaemon({ protocol: ours.protocol, build: "stale00" }, { ...ours, build: "unknown" })).toBe(false);
  });

  it("retires a draining holder to wait it out instead of adopting it", () => {
    expect(shouldRetireDaemon({ protocol: ours.protocol, build: ours.build, draining: true }, ours)).toBe(true);
    expect(shouldRetireDaemon({ protocol: ours.protocol, build: ours.build, draining: false }, ours)).toBe(false);
  });
});
