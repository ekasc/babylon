// The .canvas DSL is the shared medium for the canvas feature: the agent edits
// it with the read/write/edit tools it already has, the renderer watches the
// file and reloads. Two properties follow from that and drive the whole format.
//
// One entity per line. Moving a node or renaming a label has to be a one-line
// diff, because the agent's job is to read that diff and implement it. A format
// that rewrites the whole file on every drag makes the diff unreadable.
//
// Emit order is fixed, so parse/serialize is a fixed point. Anything that
// survives a parse comes back byte-identical, which is what lets the renderer
// write the file back after a human edit without destroying it.
//
// See docs/canvas-design-pin.md. Layout authority is still open there: `at` is
// representable so the format does not have to change when that is settled, but
// nothing in this module decides who is allowed to author it.

export const CANVAS_DSL_VERSION = 1;

/** Flow direction of the whole scene. Absent means top to bottom. */
export type CanvasDirection = "TB" | "LR";

/** Semantic roles, not Mermaid shapes: several shapes collapse onto one role. */
export const NODE_KINDS = ["process", "decision", "terminator", "data", "note", "group"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export type CanvasNode = {
  id: string;
  kind: NodeKind;
  label: string;
  /** Spatial hint. Auto-layout fills in whatever is absent. */
  at?: { x: number; y: number };
  /** Id of the containing `group` node. Groups nest. */
  in?: string;
};

export type CanvasEdge = {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
};

export type CanvasInk = {
  id: string;
  /** SVG path data, in the same coordinate space as `at`. */
  d: string;
  stroke?: string;
  width?: number;
  /** True for strokes a compile turned into nodes. Kept, because code to ink does
   *  not exist, but not drawn, so a diagram is not competing with the sketch it
   *  came from. */
  archived?: boolean;
};

export type Scene = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  ink: CanvasInk[];
  direction?: CanvasDirection;
};

export type CanvasParseError = { line: number; message: string };

export type CanvasParseResult = { ok: true; scene: Scene } | { ok: false; errors: CanvasParseError[] };

const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function isNodeKind(value: string): value is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(value);
}

type Token = { text: string; quoted: boolean };

type TokenizeResult = { ok: true; tokens: Token[] } | { ok: false; reason: string };

function tokenize(line: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === '"') {
      let text = "";
      i++;
      let closed = false;
      while (i < line.length) {
        if (line[i] === "\\" && i + 1 < line.length) {
          const esc = line[i + 1];
          text += esc === "n" ? "\n" : esc;
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          closed = true;
          i++;
          break;
        }
        text += line[i];
        i++;
      }
      if (!closed) return { ok: false, reason: "unterminated quoted value" };
      tokens.push({ text, quoted: true });
      continue;
    }
    let text = "";
    while (i < line.length && line[i] !== " " && line[i] !== "\t") {
      text += line[i];
      i++;
    }
    tokens.push({ text, quoted: false });
  }
  return { ok: true, tokens };
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function parseNumber(text: string, line: number, what: string, errors: CanvasParseError[]): number | null {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) {
    errors.push({ line, message: `${what} must be a number, got ${quote(text)}` });
    return null;
  }
  return value;
}

export function parseCanvas(text: string): CanvasParseResult {
  const errors: CanvasParseError[] = [];
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const ink: CanvasInk[] = [];

  const nodeLines = new Map<string, number>();
  const inkLines = new Map<string, number>();
  const nodeKinds = new Map<string, NodeKind>();
  /** `in` targets are resolved once every node id is known. */
  const parents: { line: number; child: string; target: string }[] = [];
  const endpoints: { line: number; from: string; to: string }[] = [];
  let direction: CanvasDirection | undefined;
  let sawHeader = false;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const raw = lines[index];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const tokenized = tokenize(trimmed);
    if (!tokenized.ok) {
      errors.push({ line, message: tokenized.reason });
      continue;
    }
    const tokens = tokenized.tokens;

    if (!sawHeader) {
      sawHeader = true;
      const version = tokens[1]?.text;
      if (tokens[0]?.text !== "canvas" || tokens.length !== 2) {
        errors.push({ line, message: `expected ${quote(`canvas ${CANVAS_DSL_VERSION}`)} on the first line` });
      } else if (version !== String(CANVAS_DSL_VERSION)) {
        errors.push({
          line,
          message: `unsupported canvas version ${version}; this build reads version ${CANVAS_DSL_VERSION}`,
        });
      }
      continue;
    }

    const directive = tokens[0];
    if (directive === undefined || directive.quoted) {
      errors.push({ line, message: `unknown directive ${quote(directive?.text ?? "")}` });
      continue;
    }

    if (directive.text === "direction") {
      const value = tokens[1]?.text;
      if (tokens.length !== 2 || (value !== "TB" && value !== "LR")) {
        const got = tokens.slice(1).map((token) => token.text).join(" ");
        errors.push({ line, message: `direction must be TB or LR, got ${quote(got)}` });
        continue;
      }
      direction = value;
      continue;
    }

    if (directive.text === "node") {
      const id = tokens[1];
      const kind = tokens[2];
      const label = tokens[3];
      if (id === undefined || kind === undefined || label === undefined) {
        errors.push({ line, message: "node needs an id, a kind and a quoted label" });
        continue;
      }
      if (!id || !kind || !label) {
        errors.push({ line, message: "node needs an id, a kind and a quoted label" });
        continue;
      }
      if (id.quoted || !ID_PATTERN.test(id.text)) {
        errors.push({ line, message: `invalid node id ${quote(id.text)}` });
        continue;
      }
      if (kind.quoted || !isNodeKind(kind.text)) {
        errors.push({
          line,
          message: `unknown node kind ${quote(kind.text)}; expected one of ${NODE_KINDS.join(", ")}`,
        });
        continue;
      }
      if (!label.quoted) {
        errors.push({ line, message: `node label must be quoted, got ${quote(label.text)}` });
        continue;
      }
      if (nodeLines.has(id.text)) {
        errors.push({ line, message: `duplicate node id ${quote(id.text)}` });
        continue;
      }

      const node: CanvasNode = { id: id.text, kind: kind.text, label: label.text };
      let bad = false;
      for (let i = 4; i < tokens.length; i++) {
        const keyword = tokens[i];
        const value = tokens[i + 1];
        if (keyword === undefined || value === undefined) {
          errors.push({ line, message: `unexpected trailing tokens in node ${quote(id.text)}` });
          bad = true;
          break;
        }
        if (keyword.quoted || value.quoted === undefined) {
          errors.push({ line, message: `unexpected trailing ${quote(keyword.text)} in node ${quote(id.text)}` });
          bad = true;
          break;
        }
        if (keyword.text === "at") {
          const parts = value.text.split(",");
          const pxRaw = parts[0];
          const pyRaw = parts[1];
          if (parts.length !== 2 || pxRaw === undefined || pyRaw === undefined) {
            errors.push({ line, message: `at takes two numbers, got ${quote(value.text)}` });
            bad = true;
            break;
          }
          const px = parseNumber(pxRaw, line, "at x", errors);
          const py = parseNumber(pyRaw, line, "at y", errors);
          if (px === null || py === null) {
            bad = true;
            break;
          }
          node.at = { x: px, y: py };
        } else if (keyword.text === "in") {
          if (!ID_PATTERN.test(value.text)) {
            errors.push({ line, message: `invalid group id ${quote(value.text)}` });
            bad = true;
            break;
          }
          node.in = value.text;
          parents.push({ line, child: id.text, target: value.text });
        } else {
          errors.push({ line, message: `unknown node keyword ${quote(keyword.text)}` });
          bad = true;
          break;
        }
        i++;
      }
      if (bad) continue;

      nodes.push(node);
      nodeLines.set(node.id, line);
      nodeKinds.set(node.id, node.kind);
      continue;
    }

    if (directive.text === "edge") {
      const from = tokens[1];
      const arrow = tokens[2];
      const to = tokens[3];
      if (!from || !arrow || !to) {
        errors.push({ line, message: "edge needs a source, an arrow and a target" });
        continue;
      }
      if (arrow.quoted || arrow.text !== "->") {
        errors.push({ line, message: `expected -> in edge, got ${quote(arrow.text)}` });
        continue;
      }
      const edge: CanvasEdge = { from: from.text, to: to.text };
      let bad = false;
      for (let i = 4; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === undefined) continue;
        if (token.quoted) {
          if (edge.label !== undefined) {
            errors.push({ line, message: "edge has more than one label" });
            bad = true;
            break;
          }
          edge.label = token.text;
        } else if (token.text === "dashed") {
          edge.dashed = true;
        } else {
          errors.push({ line, message: `unknown edge keyword ${quote(token.text)}` });
          bad = true;
          break;
        }
      }
      if (bad) continue;

      edges.push(edge);
      endpoints.push({ line, from: edge.from, to: edge.to });
      continue;
    }

    if (directive.text === "ink") {
      const id = tokens[1];
      const d = tokens[2];
      if (!id || !d) {
        errors.push({ line, message: "ink needs an id and a quoted path" });
        continue;
      }
      if (id.quoted || !ID_PATTERN.test(id.text)) {
        errors.push({ line, message: `invalid ink id ${quote(id.text)}` });
        continue;
      }
      if (!d.quoted) {
        errors.push({ line, message: `ink path must be quoted, got ${quote(d.text)}` });
        continue;
      }
      if (inkLines.has(id.text)) {
        errors.push({ line, message: `duplicate ink id ${quote(id.text)}` });
        continue;
      }

      const element: CanvasInk = { id: id.text, d: d.text };
      let bad = false;
      for (let i = 3; i < tokens.length; i++) {
        const keyword = tokens[i];
        if (keyword === undefined) continue;
        if (keyword.quoted) {
          errors.push({ line, message: `unexpected trailing ${quote(keyword.text)} in ink ${quote(id.text)}` });
          bad = true;
          break;
        }
        // A bare flag takes no value, which also means it may end the line.
        if (keyword.text === "archived") {
          element.archived = true;
          continue;
        }
        const value = tokens[i + 1];
        if (value === undefined || value.quoted) {
          errors.push({ line, message: `unexpected trailing ${quote(keyword.text)} in ink ${quote(id.text)}` });
          bad = true;
          break;
        }
        if (keyword.text === "stroke") {
          element.stroke = value.text;
        } else if (keyword.text === "width") {
          const width = parseNumber(value.text, line, "width", errors);
          if (width === null) {
            bad = true;
            break;
          }
          element.width = width;
        } else {
          errors.push({ line, message: `unknown ink keyword ${quote(keyword.text)}` });
          bad = true;
          break;
        }
        i++;
      }
      if (bad) continue;

      ink.push(element);
      inkLines.set(element.id, line);
      continue;
    }

    errors.push({ line, message: `unknown directive ${quote(directive.text)}` });
  }

  if (!sawHeader) {
    errors.push({ line: 1, message: `expected ${quote(`canvas ${CANVAS_DSL_VERSION}`)} on the first line` });
  }

  for (const parent of parents) {
    if (!nodeLines.has(parent.target)) {
      errors.push({ line: parent.line, message: `unknown group ${quote(parent.target)}` });
    } else if (nodeKinds.get(parent.target) !== "group") {
      errors.push({
        line: parent.line,
        message: `node ${quote(parent.target)} is a ${nodeKinds.get(parent.target)}, only a group can contain nodes`,
      });
    }
  }

  for (const endpoint of endpoints) {
    for (const id of [endpoint.from, endpoint.to]) {
      if (!nodeLines.has(id)) errors.push({ line: endpoint.line, message: `edge references unknown node ${quote(id)}` });
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const seen = new Set<string>();
    let cursor = node.in;
    while (cursor) {
      if (cursor === node.id) {
        errors.push({ line: nodeLines.get(node.id) ?? 1, message: `node ${quote(node.id)} contains itself` });
        break;
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      cursor = byId.get(cursor)?.in;
    }
  }

  if (errors.length) {
    // Sorted so the renderer can list problems in file order. Reference checks
    // run after the line scan, so they would otherwise arrive last.
    errors.sort((a, b) => a.line - b.line);
    return { ok: false, errors };
  }
  const scene: Scene = { nodes, edges, ink };
  if (direction) scene.direction = direction;
  return { ok: true, scene };
}

export function serializeCanvas(scene: Scene): string {
  const blocks: string[] = [];
  if (scene.nodes.length) blocks.push(scene.nodes.map(formatNode).join("\n"));
  if (scene.edges.length) blocks.push(scene.edges.map(formatEdge).join("\n"));
  if (scene.ink.length) blocks.push(scene.ink.map(formatInk).join("\n"));
  const header = scene.direction
    ? `canvas ${CANVAS_DSL_VERSION}\ndirection ${scene.direction}`
    : `canvas ${CANVAS_DSL_VERSION}`;
  return [header, ...blocks].join("\n\n") + "\n";
}

function formatNode(node: CanvasNode): string {
  let out = `node ${node.id} ${node.kind} ${quote(node.label)}`;
  if (node.at) out += ` at ${node.at.x},${node.at.y}`;
  if (node.in) out += ` in ${node.in}`;
  return out;
}

function formatEdge(edge: CanvasEdge): string {
  let out = `edge ${edge.from} -> ${edge.to}`;
  if (edge.label !== undefined) out += ` ${quote(edge.label)}`;
  if (edge.dashed) out += " dashed";
  return out;
}

function formatInk(element: CanvasInk): string {
  let out = `ink ${element.id} ${quote(element.d)}`;
  if (element.stroke !== undefined) out += ` stroke ${element.stroke}`;
  if (element.width !== undefined) out += ` width ${element.width}`;
  if (element.archived) out += " archived";
  return out;
}
