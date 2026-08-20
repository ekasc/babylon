// LSP wire protocol helpers for Babylon's language-intelligence service.
//
// These are the transport-level pieces (Content-Length framing for the JSON-RPC
// base protocol, plus diagnostic normalization) kept pure and testable so the
// eventual server process, project scoping, and UI can build on a verified
// foundation. No child processes or editor state live here.

export interface LspMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** Encode a single LSP message as a Buffers-ready string with header. */
export function encodeLspMessage(message: LspMessage): Buffer {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(body, "utf8")]);
}

export interface DecodeResult {
  messages: LspMessage[];
  /** Trailing bytes that did not yet form a complete message (detached copy). */
  rest: Buffer;
}

/**
 * Parse zero or more LSP messages from a buffer, returning complete messages
 * and any incomplete tail. Header order and extra headers are tolerated (the
 * base protocol only requires Content-Length to be present). Safe to call
 * repeatedly as streamed chunks arrive.
 */
export function decodeLspMessages(buffer: Buffer): DecodeResult {
  const messages: LspMessage[] = [];
  let cursor = buffer;
  for (;;) {
    const headerEnd = cursor.indexOf("\r\n\r\n");
    if (headerEnd === -1) break; // no complete header yet
    const headerText = cursor.toString("utf8", 0, headerEnd);
    let length: number | undefined;
    for (const line of headerText.split("\r\n")) {
      const m = /^content-length:\s*(\d+)$/i.exec(line);
      if (m) {
        length = Number(m[1]);
        break;
      }
    }
    if (length === undefined) {
      // Complete header block with no Content-Length: skip past it.
      cursor = cursor.subarray(headerEnd + 4);
      continue;
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (cursor.length < bodyEnd) break; // wait for the full body
    const body = cursor.toString("utf8", bodyStart, bodyEnd);
    try {
      messages.push(JSON.parse(body) as LspMessage);
    } catch {
      // Skip a malformed body but keep consuming the stream.
    }
    cursor = cursor.subarray(bodyEnd);
  }
  // Detach the tail so a reused/pooled input buffer cannot corrupt it.
  return { messages, rest: Buffer.from(cursor) };
}

export type LspDiagnosticSeverity = 1 | 2 | 3 | 4; // Error, Warning, Info, Hint

export interface RawLspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: LspDiagnosticSeverity;
  code?: number | string;
  source?: string;
  message: string;
}

export interface NormalizedDiagnostic {
  file: string;
  line: number; // 1-based for display
  character: number; // 1-based for display
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: number | string;
}

const SEVERITY: Record<LspDiagnosticSeverity, NormalizedDiagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** Normalize a publishDiagnostics payload into display-ready diagnostics. */
export function mapDiagnostics(
  uri: string,
  raw: RawLspDiagnostic[]
): NormalizedDiagnostic[] {
  return raw.map((d) => ({
    file: uri,
    line: d.range.start.line + 1,
    character: d.range.start.character + 1,
    severity: d.severity ? SEVERITY[d.severity] : "error",
    message: d.message,
    source: d.source,
    code: d.code,
  }));
}

/** True when two diagnostics describe the same location, message, and source. */
export function sameDiagnostic(a: NormalizedDiagnostic, b: NormalizedDiagnostic): boolean {
  return (
    a.file === b.file &&
    a.line === b.line &&
    a.character === b.character &&
    a.message === b.message &&
    a.severity === b.severity &&
    a.code === b.code &&
    a.source === b.source
  );
}

/** Diagnostics present in `next` but not in `prev` (diff-aware surfacing). */
export function newDiagnostics(
  prev: NormalizedDiagnostic[],
  next: NormalizedDiagnostic[]
): NormalizedDiagnostic[] {
  return next.filter((n) => !prev.some((p) => sameDiagnostic(p, n)));
}
