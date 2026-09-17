import { describe, expect, it } from "vitest";
import { assignProjectIdentities, PROJECT_ICONS, PROJECT_PALETTE } from "./colors";

describe("assignProjectIdentities", () => {
  it("is deterministic and independent of input order", () => {
    const cwds = ["/a/one", "/b/two", "/c/three"];
    const fwd = assignProjectIdentities(cwds);
    const rev = assignProjectIdentities([...cwds].reverse());
    for (const cwd of cwds) expect(rev.get(cwd)).toEqual(fwd.get(cwd));
  });

  it("uses palette colors and known icons", () => {
    const got = assignProjectIdentities(["/a/one"])!.get("/a/one")!;
    expect(PROJECT_ICONS).toContain(got.icon);
    expect(PROJECT_PALETTE).toContain(got.color);
  });

  it("shifts color (not icon) when icons repeat across many projects", () => {
    const cwds = Array.from({ length: PROJECT_ICONS.length + 2 }, (_, i) => `/p/${i}`);
    const got = assignProjectIdentities(cwds);
    const seen = new Map<string, string>();
    for (const cwd of cwds) {
      const id = got.get(cwd)!;
      if (seen.has(id.icon)) expect(id.color).not.toBe(seen.get(id.icon));
      else seen.set(id.icon, id.color);
    }
  });
});
