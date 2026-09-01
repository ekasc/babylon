import * as Effect from "effect/Effect";
import { projectColor } from "./colors";

export const projectColorEffect = (cwd: string): Effect.Effect<string> => Effect.sync(() => projectColor(cwd));
