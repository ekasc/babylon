import { describe, expect, it, vi } from "vitest";
import { syncDaemonTray, TRAY_ICON_DATA_URL, type DaemonTrayHandle } from "./tray";

function fake() {
  const state = {
    destroyed: false,
    tips: [] as string[],
    menus: [] as unknown[],
    clicks: [] as (() => void)[],
    popped: 0,
    destroy() {
      state.destroyed = true;
    },
    setToolTip(tip: string) {
      state.tips.push(tip);
    },
    setContextMenu(menu: unknown) {
      state.menus.push(menu);
    },
    popUpContextMenu() {
      state.popped += 1;
    },
    onClick(fn: () => void) {
      state.clicks.push(fn);
    },
  };
  return state;
}

describe("syncDaemonTray", () => {
  it("stays absent while disconnected", () => {
    const create = vi.fn();
    expect(syncDaemonTray(null, { connected: false, tooltip: "x", create, menu: () => ({}) })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("destroys the tray on disconnect", () => {
    const tray = fake();
    const create = vi.fn();
    expect(syncDaemonTray(tray, { connected: false, tooltip: "x", create, menu: () => ({}) })).toBeNull();
    expect(tray.destroyed).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates once, wires click to the menu, and refreshes after that", () => {
    const handle = fake();
    const create = vi.fn(() => handle);
    const first = syncDaemonTray(null, { connected: true, tooltip: "up", create, menu: () => "m1" });
    expect(first).toBe(handle);
    expect(create).toHaveBeenCalledTimes(1);
    expect(handle.tips).toEqual(["up"]);
    expect(handle.menus).toEqual(["m1"]);
    expect(handle.clicks.length).toBe(1);
    const click = handle.clicks[0];
    if (!click) throw new Error("missing click");
    click();
    expect(handle.popped).toBe(1);

    const second = syncDaemonTray(first, { connected: true, tooltip: "up2", create, menu: () => "m2" });
    expect(second).toBe(handle);
    expect(create).toHaveBeenCalledTimes(1);
    expect(handle.tips).toEqual(["up", "up2"]);
    expect(handle.clicks.length).toBe(1);
  });
});

describe("tray icon", () => {
  it("is an inline PNG data URL", () => {
    expect(TRAY_ICON_DATA_URL.startsWith("data:image/png;base64,")).toBe(true);
    const payload = TRAY_ICON_DATA_URL.split(",", 2)[1];
    if (payload === undefined) throw new Error("missing icon payload");
    const raw = Buffer.from(payload, "base64");
    expect([...raw.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(raw.readUInt32BE(16)).toBe(32);
    expect(raw.readUInt32BE(20)).toBe(32);
  });
});
