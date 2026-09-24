// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Hero from "./Hero";
import type { ProjectGroup, SessionMeta } from "../bridge";

function session(path: string, cwd: string, name: string, mtime: number): SessionMeta {
  return { id: path, path, cwd, name, mtime };
}

const groups: ProjectGroup[] = [
  { cwd: "/proj/babylon", sessions: [session("/s/a1", "/proj/babylon", "Babylon one", 300), session("/s/a2", "/proj/babylon", "Babylon two", 100)] },
  { cwd: "/proj/other", sessions: [session("/s/b1", "/proj/other", "Other one", 200)] },
];

const base = {
  runtimeStatus: { status: "ready" as const },
  onOpen: vi.fn(),
  onNew: vi.fn(),
};

describe("Hero recents", () => {
  it("scopes recents to the active project under a project heading", () => {
    render(<Hero {...base} groups={groups} spaceCwd="/proj/babylon" />);
    expect(screen.getByText("Recent in babylon")).toBeTruthy();
    expect(screen.getByText("Babylon one")).toBeTruthy();
    expect(screen.getByText("Babylon two")).toBeTruthy();
    expect(screen.queryByText("Other one")).toBeNull();
  });

  it("shows global recents with no active project", () => {
    render(<Hero {...base} groups={groups} spaceCwd={null} />);
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getByText("Other one")).toBeTruthy();
  });
});
