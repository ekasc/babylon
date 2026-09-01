import * as Effect from "effect/Effect";
import { getProjectFaviconCacheKey, isProjectFaviconFallbackUrl } from "./projectFavicon";

export const getProjectFaviconCacheKeyEffect = (
  environmentId: string,
  workspaceRoot: string,
  url: string,
): Effect.Effect<string> => Effect.sync(() => getProjectFaviconCacheKey(environmentId, workspaceRoot, url));

export const isProjectFaviconFallbackUrlEffect = (
  url: string | null | undefined,
): Effect.Effect<boolean> => Effect.sync(() => isProjectFaviconFallbackUrl(url));
