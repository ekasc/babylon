import { describe, expect, it } from "vitest";
import {
  createDeviceRegistry,
  pairDevice,
  revokeDevice,
  touchDevice,
  isAuthorized,
  listDevices,
  type DeviceScope,
} from "./device-pairing";
import { hashToken, newPairingToken, verifyToken } from "./remote-auth";

describe("device pairing with tokens", () => {
  it("pairs a device with a token hash and explicit scope", () => {
    let registry = createDeviceRegistry();
    const result = pairDevice(registry, {
      id: "phone-1",
      name: "Ekas phone",
      scope: ["view_tasks", "approve_deny"],
      tokenHash: hashToken("tok"),
      now: 100,
    });
    expect(typeof result).not.toBe("string");
    registry = result as ReturnType<typeof createDeviceRegistry>;
    expect(registry.devices["phone-1"]).toMatchObject({
      id: "phone-1",
      revoked: false,
      tokenHash: hashToken("tok"),
      createdAt: 100,
      lastSeenAt: 100,
    });
  });

  it("refuses empty scope, unknown scope, blank fields, and duplicate ids", () => {
    let registry = createDeviceRegistry();
    const scope: DeviceScope[] = ["view_tasks"];
    const base = { id: "d1", name: "x", scope, tokenHash: "h", now: 1 };
    expect(pairDevice(registry, { ...base, scope: [] })).toMatch(/scope/);
    expect(pairDevice(registry, { ...base, scope: ["root_everything" as never] })).toMatch(/unknown device scope/);
    expect(pairDevice(registry, { ...base, id: " " })).toMatch(/id/);
    expect(pairDevice(registry, { ...base, name: "" })).toMatch(/name/);
    expect(pairDevice(registry, { ...base, tokenHash: "" })).toMatch(/tokenHash/);
    registry = pairDevice(registry, base) as typeof registry;
    expect(pairDevice(registry, base)).toMatch(/already paired/);
  });

  it("verifies tokens and rejects revoked or unhashed devices", () => {
    let registry = createDeviceRegistry();
    registry = pairDevice(registry, {
      id: "d1",
      name: "x",
      scope: ["view_tasks"],
      tokenHash: hashToken("secret"),
      now: 1,
    }) as typeof registry;
    const device = registry.devices.d1;
    expect(verifyToken("secret", device.tokenHash!)).toBe(true);
    expect(verifyToken("wrong", device.tokenHash!)).toBe(false);
    const revoked = revokeDevice(registry, "d1");
    expect(verifyToken("secret", revoked.devices.d1.tokenHash!)).toBe(true); // hash still matches...
    expect(isAuthorized(revoked, "d1", "view_tasks")).toBe(false); // ...but the grant is dead
  });

  it("touch updates lastSeenAt without touching scope", () => {
    let registry = createDeviceRegistry();
    registry = pairDevice(registry, {
      id: "d1",
      name: "x",
      scope: ["view_tasks"],
      tokenHash: "h",
      now: 1,
    }) as typeof registry;
    registry = touchDevice(registry, "d1", 50);
    expect(registry.devices.d1.lastSeenAt).toBe(50);
    expect(registry.devices.d1.scope).toEqual(["view_tasks"]);
  });

  it("keeps listDevices copies free of mutation side effects", () => {
    let registry = createDeviceRegistry();
    registry = pairDevice(registry, {
      id: "d1",
      name: "x",
      scope: ["view_tasks"],
      tokenHash: "h",
      now: 1,
    }) as typeof registry;
    const listed = listDevices(registry);
    listed[0].scope.push("approve_deny");
    listed[0].revoked = true;
    expect(registry.devices.d1.scope).toEqual(["view_tasks"]);
    expect(registry.devices.d1.revoked).toBe(false);
  });

  it("generates non-trivial pairing tokens", () => {
    const a = newPairingToken();
    const b = newPairingToken();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(32);
  });
});
