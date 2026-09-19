import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type CanvasSceneSummary } from "../bridge";
import {
  NODE_KINDS,
  parseCanvas,
  serializeCanvas,
  type CanvasNode,
  type CanvasParseError,
  type NodeKind,
  type Scene,
} from "../lib/canvas-dsl";
import { layoutScene, type Point } from "../lib/canvas-layout";
import { rasterizeSvg } from "../lib/rasterize";
import { compileSketch, type CompileResult, type SceneChange } from "../lib/sketch-compile";
import { regionCrop } from "../lib/sketch-crop";
import { readSketch } from "../lib/sketch-geometry";
import { sceneFromMermaidText } from "../lib/mermaid-import";

const KIND_LABEL: Record<NodeKind, string> = {
  process: "Step",
  decision: "Decision",
  terminator: "Start or end",
  data: "Data",
  note: "Note",
  group: "Group",
};

/** Panel width, in pixels. Wide enough for the header controls, and never so wide
 *  that the conversation disappears. */
/** Smallest area the canvas will show, so scale does not jump with content size. */
const VIEW_MIN = 360;

/** Minimum spacing between sampled points of a freehand stroke. */
const STROKE_SAMPLE = 3;

/** Keeps handwritten coordinates readable in the file. */
const round = (value: number): number => Math.round(value * 10) / 10;

/** Movement below this counts as a selection, not a drag. */
const DRAG_THRESHOLD = 3;

const FILL: Record<NodeKind, string> = {
  process: "var(--raised)",
  decision: "var(--raised)",
  terminator: "var(--raised)",
  data: "var(--raised)",
  note: "var(--raised)",
  group: "transparent",
};

function toScenePoint(svg: SVGSVGElement, clientX: number, clientY: number): Point {
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: clientX, y: clientY };
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function uniqueName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Electron wraps IPC failures in a prefix that means nothing to a user. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

function describeChange(change: SceneChange): string {
  switch (change.kind) {
    case "node-added":
      return `add ${change.label} as ${change.nodeKind}`;
    case "node-removed":
      return `remove ${change.label}`;
    case "node-relabelled":
      return `rename ${change.from} to ${change.to}`;
    case "node-retyped":
      return `${change.id} becomes ${change.to}`;
    case "edge-added":
      return `connect ${change.from} to ${change.to}`;
    case "edge-removed":
      return `disconnect ${change.from} from ${change.to}`;
  }
}

export type CanvasPanelProps = {
  cwd: string;
  /** Mermaid source handed over from a diagram in the conversation. */
  mermaid?: string | null;
  onImported?(): void;
};

export default function CanvasPanel({ cwd, mermaid, onImported }: CanvasPanelProps) {
  const [name, setName] = useState("plan");
  const [scenes, setScenes] = useState<CanvasSceneSummary[]>([]);
  const [scene, setScene] = useState<Scene | null>(null);
  const [errors, setErrors] = useState<CanvasParseError[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const [linkTarget, setLinkTarget] = useState("");
  const [mode, setMode] = useState<"select" | "draw">("select");
  const [stroke, setStroke] = useState<Point[] | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [preview, setPreview] = useState<CompileResult | null>(null);
  /** Strokes the pending compile turned into nodes, so applying can archive them. */
  const [consumed, setConsumed] = useState<string[]>([]);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef(false);
  const importedRef = useRef<string | null>(null);

  const refreshScenes = useCallback(async () => {
    try {
      setScenes(await bridge.canvasList(cwd));
    } catch (error) {
      setStatus(messageOf(error));
    }
  }, [cwd]);

  const apply = useCallback((text: string | null) => {
    // A missing file is an empty scene, not an error and not a dead end: the
    // first edit creates it. `null` from the parser means the file is not
    // readable as a scene, which is the only case that keeps the last good one.
    const parsed = parseCanvas(text ?? serializeCanvas({ nodes: [], edges: [], ink: [] }));
    if (parsed.ok) {
      setScene(parsed.scene);
      setErrors([]);
    } else {
      // Keep the last good scene on screen and report the problem, so a typo in
      // the file does not blank the canvas.
      setErrors(parsed.errors);
    }
  }, []);

  useEffect(() => {
    void refreshScenes();
  }, [refreshScenes]);

  // Open and watch whichever scene is selected.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await bridge.canvasWatch(cwd, name);
        if (!alive) return;
        apply(result.text);
        setStatus(null);
      } catch (error) {
        // A watch that fails must say so. Leaving the panel blank and enabled
        // would look like an empty scene rather than a canvas that is not wired up.
        if (alive) setStatus(messageOf(error));
      }
    })();
    return () => {
      alive = false;
      void bridge.canvasUnwatch();
    };
  }, [cwd, name, apply]);

  // The agent edits the file with its own tools; the watcher is how those edits
  // reach the screen. Reloads are ignored mid drag so a write cannot yank a node
  // out from under the pointer.
  // The picker follows the directory, so a scene the agent creates shows up.
  useEffect(() => {
    return bridge.onCanvasScenes((list) => setScenes(list));
  }, []);

  useEffect(() => {
    return bridge.onCanvasChanged((event) => {
      if (event.name !== name || dragRef.current) return;
      apply(event.text);
      setStatus(event.text === null ? "The scene file was removed." : null);
    });
  }, [name, apply]);

  const commit = useCallback(
    async (next: Scene) => {
      setScene(next);
      try {
        await bridge.canvasWrite(cwd, name, serializeCanvas(next));
        setStatus(null);
      } catch (error) {
        setStatus(messageOf(error));
      }
    },
    [cwd, name]
  );

  const layout = useMemo(() => (scene ? layoutScene(scene) : null), [scene]);
  // A floor on the drawn area keeps a two node scene from being stretched to fill
  // the panel, and gives an empty canvas a sane scale to start drawing on.
  const view = useMemo(() => {
    if (!layout) return null;
    const width = Math.max(layout.width, VIEW_MIN);
    const height = Math.max(layout.height, VIEW_MIN);
    return {
      x: layout.x - (width - layout.width) / 2,
      y: layout.y - (height - layout.height) / 2,
      width,
      height,
    };
  }, [layout]);
  const selectedNode = scene?.nodes.find((node) => node.id === selected) ?? null;

  const strokePath = (points: Point[]): string =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`).join(" ");

  /**
   * Freehand goes in as ink, not as nodes. The agent cannot read ink, so this is
   * the half of the sketch that a later compile turns into typed nodes.
   */
  const endStroke = useCallback(
    (points: Point[]) => {
      setStroke(null);
      if (!scene || points.length < 2) return;
      const taken = new Set(scene.ink.map((element) => element.id));
      let index = scene.ink.length + 1;
      while (taken.has(`stroke-${index}`)) index += 1;
      void commit({ ...scene, ink: [...scene.ink, { id: `stroke-${index}`, d: strokePath(points) }] });
    },
    [scene, commit]
  );

  /**
   * Turns the drawing into shapes. Geometry decides what the shapes are and how
   * they nest, a model says what each one means, and the result is shown as a
   * change list before anything is written: the ink is the only copy of the
   * sketch, so replacing it is the human's call.
   */
  const compile = useCallback(async () => {
    if (!scene) return;
    setCompiling(true);
    setPreview(null);
    try {
      const sketch = readSketch(scene.ink);
      if (!sketch.regions.length) {
        setStatus("Nothing here reads as a closed shape yet. Draw a box around each part.");
        return;
      }
      const crops = await Promise.all(
        sketch.regions.map(async (region) => {
          const crop = regionCrop(scene.ink, region);
          return { regionId: region.id, dataUrl: await rasterizeSvg(crop.svg, crop.width, crop.height) };
        })
      );
      const readings = await bridge.canvasClassify(cwd, name, crops);
      setPreview(compileSketch(sketch, new Map(Object.entries(readings)), scene));
      setConsumed(sketch.regions.flatMap((region) => region.inkIds));
      setStatus(null);
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setCompiling(false);
    }
  }, [scene, cwd]);

  const applyPreview = useCallback(() => {
    if (!preview || !scene) return;
    // The strokes that became nodes are archived rather than dropped: code to ink
    // does not exist, so the drawing is the only record of it, but drawing it
    // beside the nodes it produced leaves two versions of the same shape that
    // drift apart as soon as one is moved.
    const sources = new Set(consumed);
    void commit({
      ...preview.scene,
      ink: scene.ink.map((element) => (sources.has(element.id) ? { ...element, archived: true } : element)),
    });
    setPreview(null);
    setConsumed([]);
  }, [preview, scene, consumed, commit]);

  const writeNode = useCallback(
    (id: string, patch: Partial<CanvasNode>) => {
      if (!scene) return;
      void commit({ ...scene, nodes: scene.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)) });
    },
    [scene, commit]
  );

  // A node dragged on the canvas gets an explicit position, which is the one
  // thing the human can author that the layout algorithm cannot derive.
  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!drag || !svgRef.current) return;
      const point = toScenePoint(svgRef.current, event.clientX, event.clientY);
      const moved = drag.moved || Math.hypot(point.x - drag.x, point.y - drag.y) > DRAG_THRESHOLD;
      setDrag({ ...drag, x: point.x, y: point.y, moved });
    },
    [drag]
  );

  const endDrag = useCallback(() => {
    dragRef.current = false;
    // Selecting a node is not moving it. Without this split, a plain click would
    // write an explicit position and take that node out of the automatic layout.
    if (!drag || !scene || !drag.moved) {
      setDrag(null);
      return;
    }
    const box = layout?.boxes.find((candidate) => candidate.id === drag.id);
    const next = { ...scene };
    next.nodes = scene.nodes.map((node) =>
      node.id === drag.id
        ? { ...node, at: { x: Math.round(drag.x - (box ? box.width / 2 : 0)), y: Math.round(drag.y - 22) } }
        : node
    );
    setDrag(null);
    void commit(next);
  }, [drag, scene, layout, commit]);

  const addNode = useCallback(() => {
    if (!scene) return;
    const taken = scene.nodes.map((node) => node.id);
    let index = scene.nodes.filter((node) => node.kind !== "group").length + 1;
    while (taken.includes(`node-${index}`)) index += 1;
    const node: CanvasNode = { id: `node-${index}`, kind: "process", label: `Step ${index}` };
    setSelected(node.id);
    void commit({ ...scene, nodes: [...scene.nodes, node] });
  }, [scene, commit]);

  const deleteNode = useCallback(
    (id: string) => {
      if (!scene) return;
      setSelected(null);
      void commit({
        ...scene,
        nodes: scene.nodes.filter((node) => node.id !== id).map((node) => (node.in === id ? { ...node, in: undefined } : node)),
        edges: scene.edges.filter((edge) => edge.from !== id && edge.to !== id),
      });
    },
    [scene, commit]
  );

  const connect = useCallback(() => {
    if (!scene || !selected || !linkTarget) return;
    const exists = scene.edges.some((edge) => edge.from === selected && edge.to === linkTarget);
    if (exists) {
      setStatus("Those two are already connected.");
      return;
    }
    setLinkTarget("");
    void commit({ ...scene, edges: [...scene.edges, { from: selected, to: linkTarget }] });
  }, [scene, selected, linkTarget, commit]);

  // A diagram handed over from the conversation becomes a new scene file.
  useEffect(() => {
    if (!mermaid || importedRef.current === mermaid) return;
    importedRef.current = mermaid;
    void (async () => {
      try {
        const imported = await sceneFromMermaidText(mermaid);
        const list = await bridge.canvasList(cwd);
        const target = uniqueName(list.map((entry) => entry.name), "diagram");
        await bridge.canvasWrite(cwd, target, serializeCanvas(imported));
        await refreshScenes();
        setName(target);
        onImported?.();
      } catch (error) {
        setStatus(messageOf(error));
      }
    })();
  }, [mermaid, cwd, refreshScenes, onImported]);

  return (
    <aside className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-1 border-b border-[var(--line)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="shrink-0 text-[13px] font-medium">Canvas</span>
          <select
            aria-label="Scene"
            className="shrink-0 rounded border border-[var(--line)] bg-transparent px-1 py-0.5 text-[12px]"
            value={name}
            onChange={(event) => setName(event.target.value)}
          >
            {!scenes.some((entry) => entry.name === name) ? <option value={name}>{name}</option> : null}
            {scenes.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`thread-action thread-action-text shrink-0${mode === "draw" ? " is-active" : ""}`}
            aria-pressed={mode === "draw"}
            title="Draw freehand ink. The agent cannot read ink; compile turns it into shapes."
            disabled={!scene}
            onClick={() => setMode(mode === "draw" ? "select" : "draw")}
          >
            {mode === "draw" ? "Drawing" : "Draw"}
          </button>
          <button
            type="button"
            className="thread-action thread-action-text shrink-0"
            title="Send each drawn shape to your image model to read it, then show what that would change. Nothing is written until you apply."
            disabled={!scene || compiling || !scene.ink.length}
            onClick={() => void compile()}
          >
            {compiling ? "Reading…" : "Compile"}
          </button>
          <button type="button" className="thread-action thread-action-text shrink-0" onClick={addNode} disabled={!scene}>
            Add node
          </button>
          <button
            type="button"
            className="thread-action thread-action-text shrink-0"
            title={scene?.direction === "LR" ? "Ranks run left to right" : "Ranks run top to bottom"}
            disabled={!scene}
            onClick={() => scene && void commit({ ...scene, direction: scene.direction === "LR" ? "TB" : "LR" })}
          >
            {scene?.direction === "LR" ? "↓ TB" : "→ LR"}
          </button>
        </div>
        {scene ? <span className="text-[12px] text-dim">.pi/canvas/{name}.canvas</span> : null}
      </header>

      {status || errors.length ? (
        <div className="shrink-0 border-b border-[var(--line)] px-3 py-1 text-[12px] text-[var(--warn)]">
          {status ? <p>{status}</p> : null}
          {errors.slice(0, 4).map((error) => (
            <p key={`${error.line}-${error.message}`}>
              line {error.line}: {error.message}
            </p>
          ))}
        </div>
      ) : null}

      {preview ? (
        <div className="shrink-0 border-b border-[var(--line)] bg-[var(--inset)] px-3 py-2 text-[12px]">
          <p className="font-medium">
            {preview.changes.length} change{preview.changes.length === 1 ? "" : "s"}
            {preview.unsure.length ? `, ${preview.unsure.length} question${preview.unsure.length === 1 ? "" : "s"}` : ""}
          </p>
          <ul className="mt-1 max-h-32 overflow-auto text-dim">
            {preview.changes.map((change) => (
              <li key={`${change.kind}-${"id" in change ? change.id : change.from}`}>{describeChange(change)}</li>
            ))}
            {preview.unsure.map((question) => (
              <li key={question.id} className="text-[var(--warn)]">
                {question.label ? `${question.label}: ` : ""}
                {question.reason}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button type="button" className="thread-action thread-action-text" onClick={applyPreview}>
              Apply
            </button>
            <button type="button" className="thread-action thread-action-text" onClick={() => setPreview(null)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {scene && scene.nodes.length === 0 && scene.ink.length === 0 ? (
          <p className="p-3 text-[13px] text-dim">
            Nothing here yet. Add a node to start the scene, or ask the agent to write this file.
          </p>
        ) : null}
        {view && layout ? (
          <svg
            ref={svgRef}
            className="h-full w-full touch-none select-none"
            viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
            onPointerDown={(event) => {
              if (mode !== "draw" || !svgRef.current) return;
              event.preventDefault();
              setStroke([toScenePoint(svgRef.current, event.clientX, event.clientY)]);
              svgRef.current.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (stroke && svgRef.current) {
                const point = toScenePoint(svgRef.current, event.clientX, event.clientY);
                const last = stroke[stroke.length - 1];
                // Sample sparsely: a path per mouse event makes an unreadable file.
                if (Math.hypot(point.x - last.x, point.y - last.y) >= STROKE_SAMPLE) {
                  setStroke([...stroke, point]);
                }
                return;
              }
              onPointerMove(event);
            }}
            onPointerUp={(event) => {
              if (stroke) {
                endStroke(stroke);
                return;
              }
              endDrag();
            }}
            onPointerLeave={() => {
              if (stroke) endStroke(stroke);
              else endDrag();
            }}
          >
            <defs>
              <marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {stroke ? (
              <path d={strokePath(stroke)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            ) : null}
            {/* Once a scene has nodes, its ink is the sketch the nodes came from or
                an annotation on them, so it reads as background rather than
                competing with the diagram. A scene that is only ink is the drawing
                itself and stays at full strength. */}
            <g opacity={scene && scene.nodes.length > 0 ? 0.35 : 1}>
              {scene?.ink.filter((element) => !element.archived).map((element) => (
                <path
                  key={element.id}
                  d={element.d}
                  fill="none"
                  stroke={element.stroke ?? "currentColor"}
                  strokeWidth={element.width ?? 2}
                />
              ))}
            </g>
            {layout.edges.map((edge, index) => (
              <g key={`${edge.from}-${edge.to}-${index}`} className="text-dim">
                <polyline
                  points={edge.points.map((point) => `${point.x},${point.y}`).join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeDasharray={edge.dashed ? "6 4" : undefined}
                  markerEnd="url(#canvas-arrow)"
                />
                {edge.label ? (
                  <text x={edge.labelAt.x} y={edge.labelAt.y - 4} textAnchor="middle" fontSize="11" fill="currentColor">
                    {edge.label}
                  </text>
                ) : null}
              </g>
            ))}
            {layout.boxes.map((box) => {
              const dragged = drag?.id === box.id;
              const x = dragged ? drag!.x - box.width / 2 : box.x;
              const y = dragged ? drag!.y - 22 : box.y;
              return (
                <g
                  key={box.id}
                  onPointerDown={(event) => {
                    if (box.kind === "group" || mode !== "select") return;
                    event.preventDefault();
                    dragRef.current = true;
                    setSelected(box.id);
                    setDrag({ id: box.id, x: box.x + box.width / 2, y: box.y + 22, moved: false });
                    svgRef.current?.setPointerCapture(event.pointerId);
                  }}
                  style={{ cursor: box.kind === "group" ? "default" : "grab" }}
                >
                  <rect
                    x={x}
                    y={y}
                    width={box.width}
                    height={box.height}
                    rx={box.kind === "group" ? 12 : 8}
                    fill={FILL[box.kind]}
                    stroke={box.id === selected ? "var(--accent)" : "var(--line-strong)"}
                    strokeWidth={box.id === selected ? 2 : 1}
                    strokeDasharray={box.kind === "group" ? "5 4" : undefined}
                  />
                  <text
                    x={box.kind === "group" ? x + 10 : x + box.width / 2}
                    y={box.kind === "group" ? y + 18 : y + box.height / 2 + 4}
                    textAnchor={box.kind === "group" ? "start" : "middle"}
                    fontSize="12"
                    fill="currentColor"
                  >
                    {box.label}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : (
          <p className="p-3 text-[13px] text-dim">Fix the errors above to see the scene.</p>
        )}
      </div>

      {selectedNode ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--line)] px-3 py-2">
          <input
            aria-label="Node label"
            className="min-w-0 flex-1 rounded border border-[var(--line)] bg-transparent px-2 py-1 text-[12px]"
            value={selectedNode.label}
            onChange={(event) => writeNode(selectedNode.id, { label: event.target.value })}
          />
          <select
            aria-label="Node kind"
            className="rounded border border-[var(--line)] bg-transparent px-1 py-1 text-[12px]"
            value={selectedNode.kind}
            onChange={(event) => writeNode(selectedNode.id, { kind: event.target.value as NodeKind })}
          >
            {NODE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
          <select
            aria-label="Connect to"
            className="rounded border border-[var(--line)] bg-transparent px-1 py-1 text-[12px]"
            value={linkTarget}
            onChange={(event) => setLinkTarget(event.target.value)}
          >
            <option value="">Connect to…</option>
            {scene?.nodes
              .filter((node) => node.id !== selectedNode.id)
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label}
                </option>
              ))}
          </select>
          <button type="button" className="thread-action thread-action-text shrink-0" onClick={connect} disabled={!linkTarget}>
            Connect
          </button>
          <button type="button" className="thread-action thread-action-text shrink-0" onClick={() => deleteNode(selectedNode.id)}>
            Delete
          </button>
        </div>
      ) : null}
    </aside>
  );
}
