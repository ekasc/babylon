import * as Effect from "effect/Effect";
import { canRunInBackground, defaultPolicy, type BackgroundPolicy, type EnvironmentSignals } from "./background-policy";

export const defaultPolicyEffect: Effect.Effect<BackgroundPolicy> = Effect.sync(() => defaultPolicy());

export const canRunInBackgroundEffect = (
  policy: BackgroundPolicy,
  project: string,
  env: EnvironmentSignals,
): Effect.Effect<ReturnType<typeof canRunInBackground>> =>
  Effect.sync(() => canRunInBackground(policy, project, env));
