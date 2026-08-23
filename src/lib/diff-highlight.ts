// Parses a unified diff into line-numbered rows. Plain rows paint immediately;
// Shiki upgrades code rows asynchronously with the file's real language.

import { highlight, langFromPath } from "./highlight";

export interface DiffRow {
  kind: "meta" | "hunk" | "add" | "del" | "context";
  html: string;
  oldLn: number | null;
  newLn: number | null;
}

interface ParsedRow {
  kind: DiffRow["kind"];
  text: string;
  oldLn: number | null;
  newLn: number | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseRows(diff: string): ParsedRow[] {
  if (!diff) return [];
  const rows: ParsedRow[] = [];
  let oldLn = 0;
  let newLn = 0;

  for (const raw of diff.split(/\r?\n/)) {
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file mode ") ||
      raw.startsWith("deleted file mode ") ||
      raw.startsWith("old mode ") ||
      raw.startsWith("new mode ") ||
      raw.startsWith("similarity index ") ||
      raw.startsWith("rename from ") ||
      raw.startsWith("rename to ")
    ) {
      continue;
    }
    if (raw.startsWith("Binary files ") || raw.startsWith("\\ ")) {
      rows.push({ kind: "meta", text: raw, oldLn: null, newLn: null });
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldLn = match ? Number(match[1]) : 0;
      newLn = match ? Number(match[2]) : 0;
      rows.push({ kind: "hunk", text: raw, oldLn: null, newLn: null });
      continue;
    }
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw.slice(1), oldLn: null, newLn: newLn++ });
      continue;
    }
    if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw.slice(1), oldLn: oldLn++, newLn: null });
      continue;
    }
    const text = raw.startsWith(" ") ? raw.slice(1) : raw;
    rows.push({ kind: "context", text, oldLn: oldLn++, newLn: newLn++ });
  }

  return rows;
}

function plainRows(rows: ParsedRow[]): DiffRow[] {
  return rows.map((row) => ({ ...row, html: escapeHtml(row.text) }));
}

export function renderPlainDiff(diff: string): DiffRow[] {
  return plainRows(parseRows(diff));
}

function splitHighlightedLines(html: string): string[] | null {
  const match = /<code[^>]*>([\s\S]*)<\/code>/.exec(html);
  return match ? match[1].split("\n") : null;
}

const CHUNK_LINES = 200;
const CACHE_CAP = 100;
const cache = new Map<string, DiffRow[]>();
const inflight = new Map<string, Promise<DiffRow[]>>();

function cacheKey(diff: string, path: string): string {
  let hash = 5381;
  for (let i = 0; i < diff.length; i++) hash = ((hash << 5) + hash + diff.charCodeAt(i)) >>> 0;
  return `${path}:${diff.length}:${hash}`;
}

async function highlightLines(lines: string[], lang: string | undefined): Promise<string[] | null> {
  if (!lines.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) chunks.push(lines.slice(i, i + CHUNK_LINES));
  const rendered = await Promise.all(
    chunks.map(async (chunk) => {
      const split = splitHighlightedLines(await highlight(chunk.join("\n"), lang));
      return split?.length === chunk.length ? split : null;
    })
  );
  if (rendered.some((chunk) => chunk === null)) return null;
  return rendered.flatMap((chunk) => chunk ?? []);
}

async function highlightRows(rows: ParsedRow[], path: string): Promise<DiffRow[]> {
  const language = langFromPath(path);
  const oldText = rows.filter((row) => row.kind === "del" || row.kind === "context").map((row) => row.text);
  const newText = rows.filter((row) => row.kind === "add" || row.kind === "context").map((row) => row.text);
  const [oldLines, newLines] = await Promise.all([highlightLines(oldText, language), highlightLines(newText, language)]);
  if (!oldLines || !newLines) return plainRows(rows);

  let oldIndex = 0;
  let newIndex = 0;
  return rows.map((row) => {
    if (row.kind === "del") return { ...row, html: oldLines[oldIndex++] ?? "" };
    if (row.kind === "add") return { ...row, html: newLines[newIndex++] ?? "" };
    if (row.kind === "context") {
      const html = oldLines[oldIndex++] ?? "";
      newIndex++;
      return { ...row, html };
    }
    return { ...row, html: escapeHtml(row.text) };
  });
}

export function renderDiff(diff: string, path: string): Promise<DiffRow[]> {
  const key = cacheKey(diff, path);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;

  const work = highlightRows(parseRows(diff), path).then((rows) => {
    inflight.delete(key);
    if (cache.size >= CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, rows);
    return rows;
  });
  inflight.set(key, work);
  return work;
}
