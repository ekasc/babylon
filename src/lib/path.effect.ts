import * as Effect from "effect/Effect";
import { isUncPath, isWindowsAbsolutePath, isWindowsDrivePath, normalizeProjectPathForComparison, normalizeProjectPathForDispatch } from "./path";

export const normalizeProjectPathForDispatchEffect = (value: string): Effect.Effect<string> =>
  Effect.sync(() => normalizeProjectPathForDispatch(value));

export const normalizeProjectPathForComparisonEffect = (value: string): Effect.Effect<string> =>
  Effect.sync(() => normalizeProjectPathForComparison(value));

export const isWindowsDrivePathEffect = (value: string): Effect.Effect<boolean> =>
  Effect.sync(() => isWindowsDrivePath(value));

export const isUncPathEffect = (value: string): Effect.Effect<boolean> => Effect.sync(() => isUncPath(value));

export const isWindowsAbsolutePathEffect = (value: string): Effect.Effect<boolean> =>
  Effect.sync(() => isWindowsAbsolutePath(value));
