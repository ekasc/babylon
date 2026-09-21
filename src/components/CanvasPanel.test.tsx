// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CanvasPanel from "./CanvasPanel";

vi.mock("../lib/rasterize", () => ({ rasterizeSvg: async () => "data:image/png;base64,AAAA" }));

const SCENE = `canvas 1

node flow group "Checkout"
node cart process "Cart" in flow
node paid decision "Paid?" in flow

edge cart -> paid "submit"
`;

const state = vi.hoisted(() => ({ writes: [] as string[], watched: "" as string | null, readings: {} as Record<string, unknown> }));

vi.mock("../bridge", () => ({
  bridge: {
    canvasList: async () => [{ name: "plan", path: "/p/.pi/canvas/plan.canvas", mtime: 0, size: 0 }],
    canvasWrite: async (_cwd: string, _name: string, text: string) => {
      state.writes.push(text);
      return { path: "/p/.pi/canvas/plan.canvas" };
    },
    canvasWatch: async () => ({ path: "/p/.pi/canvas/plan.canvas", name: "plan", text: state.watched }),
    canvasClassify: async () => state.readings,
    canvasUnwatch: async () => ({ ok: true }),
    onCanvasChanged: () => () => {},
    onCanvasScenes: () => () => {},
  },
}));

beforeEach(() => {
  state.writes = [];
  state.watched = SCENE;
  state.readings = {};
  // jsdom has no pointer capture, and the drag handler uses it.
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(cleanup);

function renderPanel() {
  return render(<CanvasPanel cwd="/p" />);
}

/** A press and release with no movement, which is a selection rather than a drag. */
function clickNode(label: string) {
  const target = screen.getByText(label);
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("canvas panel", () => {
  it("draws the scene it reads from the project file", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Cart")).toBeTruthy());
    expect(screen.getByText("Paid?")).toBeTruthy();
    expect(screen.getByText("Checkout")).toBeTruthy();
    expect(screen.getByText("submit")).toBeTruthy();
    expect(screen.getByText(".pi/canvas/plan.canvas")).toBeTruthy();
  });

  it("starts an empty scene so a missing file is not a dead end", async () => {
    state.watched = null;
    renderPanel();
    await waitFor(() => expect((screen.getByRole("button", { name: "Add node" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
  });

  it("writes the scene back when a node is added", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Cart")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toContain('node node-3 process "Step 3"');
    expect(state.writes[0]).toContain('node cart process "Cart" in flow');
  });

  it("writes a rename as a one line change", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Cart")).toBeTruthy());
    clickNode("Cart");
    const input = await screen.findByLabelText("Node label");
    fireEvent.change(input, { target: { value: "Basket" } });
    await waitFor(() => expect(state.writes.length).toBeGreaterThan(0));
    const last = state.writes[state.writes.length - 1];
    if (last === undefined) throw new Error("missing write");
    // The whole claim of the format: a rename touches one line, so the agent can
    // read the diff and act on it.
    expect(last.split("\n").filter((line, index) => line !== SCENE.split("\n")[index])).toEqual([
      'node cart process "Basket" in flow',
    ]);
  });

  it("treats a click as a selection and not as a move", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("Cart")).toBeTruthy());
    clickNode("Cart");
    await screen.findByLabelText("Node label");
    // An explicit position here would drop the node out of the automatic layout.
    expect(state.writes).toEqual([]);
  });

  it("reports a broken file with line numbers instead of blanking the canvas", async () => {
    state.watched = 'canvas 1\nnode cart widget "Cart"\nedge cart -> ghost\n';
    renderPanel();
    await waitFor(() => expect(screen.getByText(/line 2: unknown node kind/, { selector: "p" })).toBeTruthy());
    // Both ends of the edge are unknown, and both are reported.
    expect(screen.getAllByText(/line 3: edge references unknown node/, { selector: "p" }).map((node) => node.textContent)).toEqual([
      'line 3: edge references unknown node "cart"',
      'line 3: edge references unknown node "ghost"',
    ]);
  });
});

describe("compiling a sketch", () => {
  const SKETCH = `canvas 1

ink stroke-1 "M10 10 L110 10 L110 70 L10 70 Z"
`;

  it("shows what it would change before writing anything", async () => {
    state.watched = SKETCH;
    state.readings = { r1: { role: "decision", label: "Paid?", confidence: 0.9 } };
    renderPanel();
    await waitFor(() => expect(screen.getByText("Compile")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));

    await waitFor(() => expect(screen.getByText("1 change")).toBeTruthy());
    expect(screen.getByText("add Paid? as decision")).toBeTruthy();
    // The drawing is the only copy of the sketch, so nothing is written until asked.
    expect(state.writes).toEqual([]);
  });

  it("asks about a shape it could not name", async () => {
    state.watched = SKETCH;
    state.readings = {};
    renderPanel();
    await waitFor(() => expect(screen.getByText("Compile")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));

    await waitFor(() => expect(screen.getByText("1 change, 1 question")).toBeTruthy());
    expect(screen.getByText(/no reading was produced for this shape/)).toBeTruthy();
  });

  it("archives the drawing when the compile is applied", async () => {
    state.watched = SKETCH;
    state.readings = { r1: { role: "process", label: "Cart", confidence: 0.9 } };
    renderPanel();
    await waitFor(() => expect(screen.getByText("Compile")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    await waitFor(() => expect(screen.getByText("1 change")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toContain('node cart process "Cart" at 24,24');
    // Code to ink does not exist, so the sketch stays underneath what it compiled to.
    // Archived, not dropped: still in the file, no longer drawn beside its node.
    expect(state.writes[0]).toContain('ink stroke-1 "M10 10 L110 10 L110 70 L10 70 Z" archived');
  });

  it("says so when the drawing has no closed shape to compile", async () => {
    state.watched = `canvas 1

ink stroke-1 "M10 10 L200 10"
`;
    renderPanel();
    await waitFor(() => expect(screen.getByText("Compile")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));

    await waitFor(() => expect(screen.getByText(/Nothing here reads as a closed shape yet/)).toBeTruthy());
    expect(state.writes).toEqual([]);
  });
});
