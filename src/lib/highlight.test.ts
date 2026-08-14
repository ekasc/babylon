import { describe, expect, it } from "vitest";
import { cachedHighlight, highlight } from "./highlight";

// Exercises both highlight paths: the eager core grammars and the on-demand
// lazy load of a heavy grammar (cpp is ~800 KB and must not be fetched until a
// cpp block actually appears).
describe("highlight language loading", () => {
  it("highlights a core language without extra loads", async () => {
    const html = await highlight("def add(a, b):\n    return a + b", "python");
    expect(html).toContain('class="shiki');
    expect(html).toContain("add");
  });

  it("loads a heavy grammar on demand", async () => {
    const html = await highlight("int main() { return 0; }", "cpp");
    expect(html).toContain('class="shiki');
    expect(html).toContain("main");
  });

  it("falls back to plain output for unknown languages", async () => {
    const html = await highlight("hello world", "not-a-language");
    expect(html).toContain("shiki-plain");
    expect(html).toContain("hello world");
  });
});

describe("highlight render cache", () => {
  it("starts empty and caches after the first render", async () => {
    const code = "def cache_me():\n    return 1";
    expect(cachedHighlight(code, "python")).toBeNull();
    const html = await highlight(code, "python");
    expect(html).toContain('class="shiki');
    expect(cachedHighlight(code, "python")).toBe(html);
  });

  it("dedupes concurrent renders of the same block", async () => {
    const code = "print(1)";
    const [a, b] = await Promise.all([highlight(code, "python"), highlight(code, "python")]);
    expect(a).toBe(b);
    expect(cachedHighlight(code, "python")).toBe(a);
  });

  it("keys by language", async () => {
    const code = "def x():\n    pass";
    const py = await highlight(code, "python");
    const js = await highlight(code, "javascript");
    expect(py).not.toBe(js);
  });
});
