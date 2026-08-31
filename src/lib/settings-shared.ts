export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface PiSettings {
  chatModel?: ModelRef;
  chatReasoning?: string;
  titleModel?: ModelRef;
  titleReasoning?: string;
  gitCommitModel?: ModelRef;
  gitCommitPrompt?: string;
  contextWindowOverrides?: Record<string, number>;
  appearance?: { theme?: "light" | "dark" | "system"; useSystemFonts?: boolean; monoFontFamily?: string };
  compaction?: { mode?: "automatic" | "summary" | "snapcompact" };
  daemon?: { enabled?: boolean };
}

export const DEFAULT_GIT_COMMIT_MODEL: ModelRef = {
  provider: "opencode-go",
  modelId: "muse-spark-1.2-contributor",
};

export const DEFAULT_CHAT_MODEL: ModelRef = {
  provider: "opencode-go",
  modelId: "muse-spark-1.2-contributor",
};

export const DEFAULT_GIT_COMMIT_PROMPT =
  "Describe the primary change and why it matters. Follow the repository's existing commit style when the recent history makes it clear.";
