import * as Effect from "effect/Effect";
import { collectDiagnostics, type DiagnosticsInput, type DiagnosticsSnapshot } from "./diagnostics";

export const collectDiagnosticsEffect = (input: DiagnosticsInput): Effect.Effect<DiagnosticsSnapshot> =>
  Effect.sync(() => collectDiagnostics(input));
