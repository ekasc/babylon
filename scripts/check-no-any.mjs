// Ban on `any` / `as any` / `as never` (see AGENTS.md).
//
// Uses the TypeScript compiler API (not grep) so words in comments and
// string literals never trip it. Walks the first-party sources in
// src/, electron/ and daemon/ and fails on:
//   - any-keyword type annotations (`x: any`, `Array<any>`, `Promise<any>`, ...)
//   - `expr as any` / `<any>expr` assertions
//   - `expr as never` / `satisfies any|never` assertions
//
// Usage: node scripts/check-no-any.mjs
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src", "electron", "daemon"];
const EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);

function collect(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) collect(path, out);
    else if ([...EXT].some((e) => path.endsWith(e))) out.push(path);
  }
}

const files = [];
for (const root of ROOTS) {
  try {
    collect(root, files);
  } catch {
    /* root absent */
  }
}

const violations = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const parent = node.parent;
      const inAssertion =
        parent &&
        (parent.kind === ts.SyntaxKind.AsExpression ||
          parent.kind === ts.SyntaxKind.TypeAssertionExpression ||
          parent.kind === ts.SyntaxKind.SatisfiesExpression) &&
        parent.type === node;
      violations.push({ file, pos: node.getStart(source), kind: inAssertion ? "as-any" : "any-annotation" });
    } else if (node.kind === ts.SyntaxKind.NeverKeyword) {
      const parent = node.parent;
      if (
        parent &&
        (parent.kind === ts.SyntaxKind.AsExpression ||
          parent.kind === ts.SyntaxKind.TypeAssertionExpression ||
          parent.kind === ts.SyntaxKind.SatisfiesExpression) &&
        parent.type === node
      ) {
        violations.push({ file, pos: node.getStart(source), kind: "as-never" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length) {
  const lineOf = (file, text, pos) => {
    let line = 1;
    let character = 0;
    for (let i = 0; i < pos; i++) {
      if (text[i] === "\n") {
        line++;
        character = 0;
      } else {
        character++;
      }
    }
    return { line, character };
  };
  const texts = new Map();
  for (const v of violations.sort((a, b) => (a.file < b.file ? -1 : 1) || a.pos - b.pos)) {
    if (!texts.has(v.file)) texts.set(v.file, readFileSync(v.file, "utf8"));
    const { line, character } = lineOf(v.file, texts.get(v.file), v.pos);
    console.error(`${relative(process.cwd(), v.file)}:${line}:${character + 1} banned ${v.kind}`);
  }
  console.error(`\ncheck-no-any: ${violations.length} violation(s). any/as-any/as-never are banned.`);
  process.exit(1);
}
console.log(`check-no-any: clean (${files.length} files).`);
