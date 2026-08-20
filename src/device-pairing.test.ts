import { describe, expect, it } from "vitest";
import {
  createDeviceRegistry,
  isAuthorized,
  listDevices,
  registerDevice,
  revokeDevice,
  touchDevice,
  type DeviceRegistry,
  type PairedDevice,
} from "./device-pairing";

function device(over: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: "d1",
    name: "Phone",
    createdAt: 1,
    lastSeenAt: 1,
    scope: ["view_tasks", "approve_deny"],
    revoked: false,
    ...over,
  };
}

describe("device pairing", () => {
  it("registers a device and refuses to overwrite", () => {
    let r: DeviceRegistry = createDeviceRegistry();
    r = registerDevice(r, device());
    expect(r.devices.d1.name).toBe("Phone");
    r = registerDevice(r, device({ name: "Laptop" }));
    expect(r.devices.d1.name).toBe("Phone");
  });

  it("stores a copy so later caller mutation cannot change the registry", () => {
    const original = device();
    const r = registerDevice(createDeviceRegistry(), original);
    original.name = "Hacked";
    expect(r.devices.d1.name).toBe("Phone");
  });

  it("revokes a device and is a no-op on missing/already-revoked", () => {
    let r = registerDevice(createDeviceRegistry(), device());
    r = revokeDevice(r, "d1");
    expect(r.devices.d1.revoked).toBe(true);
    expect(revokeDevice(r, "d1")).toBe(r);
    expect(revokeDevice(r, "missing")).toBe(r);
  });

  it("updates last-seen and is a no-op on missing", () => {
    let r = registerDevice(createDeviceRegistry(), device());
    r = touchDevice(r, "d1", 99);
    expect(r.devices.d1.lastSeenAt).toBe(99);
    expect(touchDevice(r, "missing", 99)).toBe(r);
  });

  it("authorizes only present, unrevoked devices within scope", () => {
    const r = registerDevice(createDeviceRegistry(), device());
    expect(isAuthorized(r, "d1", "view_tasks")).toBe(true);
    expect(isAuthorized(r, "d1", "view_diffs")).toBe(false);
    expect(isAuthorized(r, "missing", "view_tasks")).toBe(false);
    const revoked = revokeDevice(r, "d1");
    expect(isAuthorized(revoked, "d1", "view_tasks")).toBe(false);
  });

  it("lists all devices", () => {
    let r = createDeviceRegistry();
    r = registerDevice(r, device({ id: "a" }));
    r = registerDevice(r, device({ id: "b" }));
    expect(listDevices(r).map((d) => d.id).sort()).toEqual(["a", "b"]);
  });
});
