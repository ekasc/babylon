import * as Effect from "effect/Effect";
import { createDeviceRegistry, type DeviceRegistry } from "./device-pairing";

export const createDeviceRegistryEffect: Effect.Effect<DeviceRegistry> = Effect.sync(() =>
  createDeviceRegistry(),
);
