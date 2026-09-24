// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlantUmlBlock from "./PlantUmlBlock";

afterEach(() => cleanup());

describe("PlantUmlBlock (A08)", () => {
  it("shows source with explicit remote consent, fetches nothing implicitly", async () => {
    render(<PlantUmlBlock code="@startuml\nA -> B\n@enduml" />);
    expect(screen.getByText("@startuml", { exact: false })).toBeTruthy();
    const button = screen.getByRole("button", { name: /remote preview/i });
    expect(document.querySelector("img.plantuml-block")).toBeNull();
    await userEvent.click(button);
    // Consent starts loading; no <img> until the remote render resolves.
    expect(document.querySelector("img.plantuml-block")).toBeNull();
  });
});
