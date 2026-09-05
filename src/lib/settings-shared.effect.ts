import * as Effect from "effect/Effect";
import { DEFAULT_CHAT_MODEL, DEFAULT_GIT_COMMIT_MODEL, type PiSettings } from "./settings-shared";

export const getDefaultChatModelEffect = (): Effect.Effect<typeof DEFAULT_CHAT_MODEL> =>
  Effect.sync(() => DEFAULT_CHAT_MODEL);

export const getDefaultGitCommitModelEffect = (): Effect.Effect<typeof DEFAULT_GIT_COMMIT_MODEL> =>
  Effect.sync(() => DEFAULT_GIT_COMMIT_MODEL);

export const validatePiSettingsEffect = (settings: PiSettings): Effect.Effect<PiSettings> =>
  Effect.sync(() => settings);
