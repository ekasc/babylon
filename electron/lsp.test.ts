import { describe, expect, it } from "vitest";
import {
  decodeLspMessages,
  encodeLspMessage,
  mapDiagnostics,
  newDiagnostics,
  sameDiagnostic,
  type LspMessage,
} from "./lsp";

describe("encodeLspMessage", () => {
  it("prefixes the body with a Content-Length header", () => {
    const msg: LspMessage = { jsonrpc: "2.0", method: "initialize", id: 1 };
    const buf = encodeLspMessage(msg);
    const text = buf.toString("utf8");
    expect(text.startsWith("Content-Length: ")).toBe(true);
    expect(text.endsWith('\r\n\r\n{"jsonrpc":"2.0","method":"initialize","id":1}')).toBe(true);
  });
});

describe("decodeLspMessages", () => {
  it("round-trips a single message", () => {
    const msg: LspMessage = { jsonrpc: "2.0", method: "initialized" };
    const { messages, rest } = decodeLspMessages(encodeLspMessage(msg));
    expect(messages).toHaveLength(1);
    expect(messages[0].method).toBe("initialized");
    expect(rest.length).toBe(0);
  });

  it("parses concatenated messages", () => {
    const a = encodeLspMessage({ jsonrpc: "2.0", method: "a" });
    const b = encodeLspMessage({ jsonrpc: "2.0", method: "b", id: 2 });
    const { messages } = decodeLspMessages(Buffer.concat([a, b]));
    expect(messages.map((m) => m.method)).toEqual(["a", "b"]);
  });

  it("returns incomplete tail when a body is split across chunks", () => {
    const full = encodeLspMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { a: 1 } });
    const first = full.subarray(0, 10);
    const second = full.subarray(10);
    const r1 = decodeLspMessages(first);
    expect(r1.messages).toHaveLength(0);
    const r2 = decodeLspMessages(Buffer.concat([r1.rest, second]));
    expect(r2.messages).toHaveLength(1);
    expect(r2.messages[0].method).toBe("window/logMessage");
  });

  it("skips malformed bodies without losing the stream", () => {
    const good = encodeLspMessage({ jsonrpc: "2.0", method: "ok" });
    // Body length matches the declared Content-Length (so the stream stays in
    // sync); only the JSON is invalid. The decoder skips it and keeps going.
    const bad = Buffer.from("Content-Length: 9\r\n\r\n{notjson}");
    const { messages } = decodeLspMessages(Buffer.concat([bad, good]));
    expect(messages).toHaveLength(1);
    expect(messages[0].method).toBe("ok");
  });
});

describe("mapDiagnostics", () => {
  it("converts LSP ranges to 1-based display positions", () => {
    const out = mapDiagnostics("file:///a.ts", [
      {
        range: {
          start: { line: 2, character: 3 },
          end: { line: 2, character: 8 },
        },
        severity: 1,
        source: "ts",
        code: "2322",
        message: "Type error",
      },
    ]);
    expect(out[0]).toMatchObject({
      file: "file:///a.ts",
      line: 3,
      character: 4,
      severity: "error",
      source: "ts",
      code: "2322",
      message: "Type error",
    });
  });

  it("defaults missing severity to error", () => {
    const out = mapDiagnostics("file:///a.ts", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "x" }]);
    expect(out[0].severity).toBe("error");
  });
});

describe("header flexibility", () => {
  it("parses when Content-Type precedes Content-Length", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "a" });
    const buf = Buffer.from(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    );
    const { messages } = decodeLspMessages(buf);
    expect(messages).toHaveLength(1);
    expect(messages[0].method).toBe("a");
  });

  it("tolerates extra headers", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "b" });
    const buf = Buffer.from(
      `Content-Length: ${Buffer.byteLength(body)}\r\nX-Foo: bar\r\n\r\n${body}`
    );
    const { messages } = decodeLspMessages(buf);
    expect(messages).toHaveLength(1);
    expect(messages[0].method).toBe("b");
  });

  it("returns a detached rest that still parses the next message", () => {
    const a = encodeLspMessage({ jsonrpc: "2.0", method: "a" });
    const b = encodeLspMessage({ jsonrpc: "2.0", method: "b" });
    const partial = Buffer.concat([a, b]).subarray(0, a.length + 3);
    const r1 = decodeLspMessages(partial);
    expect(r1.messages).toHaveLength(1);
    // The caller keeps rest and appends the *next* chunk, which is the portion
    // of b not already consumed into rest.
    const r2 = decodeLspMessages(Buffer.concat([r1.rest, b.subarray(3)]));
    expect(r2.messages).toHaveLength(1);
    expect(r2.messages[0].method).toBe("b");
  });
});

describe("sameDiagnostic", () => {
  const base = { file: "f", line: 1, character: 1, severity: "error" as const, message: "m" };
  it("treats a different code as distinct", () => {
    expect(sameDiagnostic({ ...base, code: "1" }, { ...base, code: "2" })).toBe(false);
  });
  it("treats a different source as distinct", () => {
    expect(sameDiagnostic({ ...base, source: "ts" }, { ...base, source: "es" })).toBe(false);
  });
});

describe("newDiagnostics", () => {
  const base = [
    { file: "f", line: 1, character: 1, severity: "error" as const, message: "a" },
    { file: "f", line: 2, character: 1, severity: "warning" as const, message: "diff" },
  ];

  it("returns diagnostics added since the previous set", () => {
    const next = [
      ...base,
      { file: "f", line: 3, character: 1, severity: "error" as const, message: "b" },
    ];
    const added = newDiagnostics(base, next);
    expect(added).toHaveLength(1);
    expect(added[0].message).toBe("b");
  });

  it("returns none when the set is unchanged", () => {
    expect(newDiagnostics(base, base)).toHaveLength(0);
  });
});
