import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import ModelPicker from "./ModelPicker";
import ThinkingPicker from "./ThinkingPicker";
import StatsPopover from "./StatsPopover";
import { SparkleIcon } from "./icons";

interface Props {
  agentState: any;
  stats: any;
  models: any[];
  onSetModel(provider: string, modelId: string): void;
  onSetThinking(level: string): void;
  onCompact(): void;
}

export default function StatusBar({ agentState, stats, models, onSetModel, onSetThinking, onCompact }: Props) {
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const model = agentState?.model ?? null;

  // Load the levels the current model actually supports.
  useEffect(() => {
    let alive = true;
    bridge
      .getThinkingLevels()
      .then((lv) => {
        if (alive && lv.length) setThinkingLevels(lv);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentState?.model?.id]);

  return (
    <footer className="glass statusbar-text flex h-9 shrink-0 items-center gap-1.5 border-t border-line/40 px-2.5 text-[11.5px] text-dim">
      <ModelPicker
        models={models}
        current={model}
        disabled={!models.length}
        onSelect={onSetModel}
      />

      <ThinkingPicker
        current={agentState?.thinkingLevel ?? "off"}
        available={thinkingLevels.length ? thinkingLevels : undefined}
        disabled={!agentState}
        onSelect={onSetThinking}
      />

      <div className="ml-auto flex items-center gap-1.5">
        {agentState?.isStreaming && (
          <span className="flex items-center gap-1 text-accent">
            <SparkleIcon size={11} />
            working…
          </span>
        )}
        <StatsPopover stats={stats} hasSession={!!agentState} onCompact={onCompact} />
      </div>
    </footer>
  );
}
