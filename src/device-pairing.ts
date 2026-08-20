// Device pairing for Phase 7 (Remote Control, Feature 15).
//
// Remote and mobile control starts with explicit device pairing and revocable
// grants. Each paired device has an identity, an authorization scope (the small
// set of remote actions it may perform), creation/last-seen times, and a revoke
// flag. The registry is pure and testable; the transport and approval UI build
// on top.

export type DeviceScope =
  | "view_tasks"
  | "view_state"
  | "receive_attention"
  | "approve_deny"
  | "answer_questions"
  | "stop_resume"
  | "view_diffs";

export const ALL_DEVICE_SCOPES: readonly DeviceScope[] = [
  "view_tasks",
  "view_state",
  "receive_attention",
  "approve_deny",
  "answer_questions",
  "stop_resume",
  "view_diffs",
];

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  scope: DeviceScope[];
  revoked: boolean;
}

export interface DeviceRegistry {
  devices: Record<string, PairedDevice>;
}

export function createDeviceRegistry(): DeviceRegistry {
  return { devices: {} };
}

export function registerDevice(registry: DeviceRegistry, device: PairedDevice): DeviceRegistry {
  if (registry.devices[device.id]) return registry; // no clobber
  // Copy the scope array so a later mutation of the caller's object cannot
  // change the stored grant (privilege escalation).
  return { devices: { ...registry.devices, [device.id]: { ...device, scope: [...device.scope] } } };
}

export function revokeDevice(registry: DeviceRegistry, id: string): DeviceRegistry {
  const existing = registry.devices[id];
  if (!existing || existing.revoked) return registry;
  return { devices: { ...registry.devices, [id]: { ...existing, scope: [...existing.scope], revoked: true } } };
}

export function touchDevice(registry: DeviceRegistry, id: string, at: number): DeviceRegistry {
  const existing = registry.devices[id];
  if (!existing) return registry;
  return { devices: { ...registry.devices, [id]: { ...existing, scope: [...existing.scope], lastSeenAt: at } } };
}

export function isAuthorized(registry: DeviceRegistry, id: string, action: DeviceScope): boolean {
  const device = registry.devices[id];
  if (!device || device.revoked) return false;
  return device.scope.includes(action);
}

export function listDevices(registry: DeviceRegistry): PairedDevice[] {
  // Return copies so a caller cannot mutate a returned device to defeat
  // revocation or escalate scope.
  return Object.values(registry.devices).map((d) => ({ ...d, scope: [...d.scope] }));
}
