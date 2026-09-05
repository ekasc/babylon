import * as Effect from "effect/Effect";
import { renderDiff, renderPlainDiff } from "./diff-highlight";

export const renderPlainDiffEffect = (diff: string) => Effect.sync(() => renderPlainDiff(diff));

export const renderDiffEffect = (diff: string, path: string) => Effect.promise(() => renderDiff(diff, path));
