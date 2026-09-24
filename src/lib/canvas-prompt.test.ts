import { describe, expect, it } from "vitest";
import { NODE_KINDS } from "./canvas-dsl";
import { CANVAS_PROMPT } from "./canvas-prompt";

// The prompt is the agent's only documentation of the format: nothing else tells
// it what the DSL accepts. These are consistency checks against the parser, not
// spell checks on prose, because drift here means the agent writes a file the
// parser rejects.
describe("the canvas prompt", () => {
  it("names every node kind the parser accepts", () => {
    for (const kind of NODE_KINDS) expect(CANVAS_PROMPT).toContain(kind);
  });

  it("names the header, the directives and the keywords", () => {
    for (const token of ["canvas 1", "direction", "node ", "edge ", "ink ", "at ", " in ", "dashed", "archived"]) {
      expect(CANVAS_PROMPT).toContain(token);
    }
  });

  it("says where scenes live", () => {
    expect(CANVAS_PROMPT).toContain(".pi/canvas");
  });

  it("says what a human edit means", () => {
    // The whole point of the round trip: a scene the human touched is an
    // instruction, not a document to admire.
    expect(CANVAS_PROMPT).toContain("request");
  });

  it("says to leave layout alone", () => {
    expect(CANVAS_PROMPT).toContain("`at`");
  });

  it("names the canvas tools and the check-before-write loop", () => {
    expect(CANVAS_PROMPT).toContain("canvas_check");
    expect(CANVAS_PROMPT).toContain("canvas_write");
  });
});
