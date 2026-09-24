// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import CodeBlock from "./CodeBlock";

afterEach(() => cleanup());

describe("CodeBlock shell (terminal) rendering", () => {
  it("renders bash blocks as the composer-style shell surface", () => {
    const { container } = render(<CodeBlock code={"echo hello world\n"} lang="bash" />);
    const block = container.querySelector(".codeblock")!;
    expect(block.className).toContain("is-shell");
    expect(container.querySelector(".codeblock-shell-prompt")).toBeTruthy();
    expect(container.textContent).toContain("echo hello world");
  });

  it("keeps the code-editor treatment (no prompt glyph) for code languages", () => {
    const { container } = render(<CodeBlock code={"const answer = 42;\n"} lang="ts" />);
    const block = container.querySelector(".codeblock")!;
    expect(block.className).not.toContain("is-shell");
    expect(container.querySelector(".codeblock-shell-prompt")).toBeNull();
    expect(container.querySelector(".codeblock-lineno")).toBeTruthy();
  });
});