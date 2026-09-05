import * as Effect from "effect/Effect";
import { isWorkspaceBrowserPreviewPath, isWorkspaceImagePreviewPath, isWorkspacePreviewEntryPath } from "./filePreview";

export const isWorkspaceBrowserPreviewPathEffect = (path: string): Effect.Effect<boolean> =>
  Effect.sync(() => isWorkspaceBrowserPreviewPath(path));

export const isWorkspaceImagePreviewPathEffect = (path: string): Effect.Effect<boolean> =>
  Effect.sync(() => isWorkspaceImagePreviewPath(path));

export const isWorkspacePreviewEntryPathEffect = (path: string): Effect.Effect<boolean> =>
  Effect.sync(() => isWorkspacePreviewEntryPath(path));
