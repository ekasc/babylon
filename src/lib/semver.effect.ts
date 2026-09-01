import * as Effect from "effect/Effect";
import { compareSemverVersions, normalizeSemverVersion, parseSemver, satisfiesSemverRange } from "./semver";

export const normalizeSemverVersionEffect = (version: string): Effect.Effect<string> =>
  Effect.sync(() => normalizeSemverVersion(version));

export const parseSemverEffect = (value: string): Effect.Effect<ReturnType<typeof parseSemver>> =>
  Effect.sync(() => parseSemver(value));

export const compareSemverVersionsEffect = (left: string, right: string): Effect.Effect<number> =>
  Effect.sync(() => compareSemverVersions(left, right));

export const satisfiesSemverRangeEffect = (rawVersion: string, range: string): Effect.Effect<boolean> =>
  Effect.sync(() => satisfiesSemverRange(rawVersion, range));
