import Composer, { type Attachment } from "./Composer";
import PermissionModePicker from "./PermissionModePicker";
import ModelPicker from "./ComposerModelPicker";
import ThinkingPicker from "./ComposerThinkingPicker";
import StatsPopover from "./StatsPopover";
import { formatContextPercent } from "../lib/format";
import { formatContextPercentEffect } from "../lib/format.effect";
import * as Effect from "effect/Effect";

function ThroughputBars({ active }: { active: boolean }) {
  return (
    <span className={`throughput-bars inline-flex items-end gap-[2px] font-mono leading-none ${active ? "text-dim" : "text-dim/35"}`} aria-label={active ? "Agent is running" : "Agent idle"} aria-live="polite" title={active ? "Agent is running" : "Idle"} aria-hidden={active ? "false" : "true"}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`throughput-bar ${active ? "is-active" : "is-idle"}`}
          style={{ animationDelay: `${i * 90}ms` } as any}
          aria-hidden
        />
      ))}
    </span>
  );
}

interface Props {
	agentState: any;
	stats: any;
	models?: any[];
	thinkingLevels?: string[];
	onSetModel?: (provider: string, modelId: string) => void;
	onSetThinking?: (level: string) => void;
	onCompact?: () => void;
	streaming?: boolean;
	steering?: string[];
	followUp?: string[];
	commands?: any[];
	draftRequest?: { id: number; text: string } | null;
	toast?: (kind: "info" | "warning" | "error", text: string) => void;
	onSend?: (
		text: string,
		images: Attachment[] | undefined,
		streamingBehavior?: "steer" | "followUp",
	) => Promise<boolean>;
	onAbort?: () => void;
	dialogs?: any[];
	onDialogDismiss?: (id: string) => void;
	runningWorkflows?: number;
	subagentCount?: number;
}

function fmtContext(stats: any) {
	return Effect.runSync(
		formatContextPercentEffect(stats?.contextUsage?.percent, stats?.contextUsage?.tokens, stats?.contextUsage?.contextWindow),
	);
}

export default function SessionFooter({
	agentState,
	stats,
	models,
	thinkingLevels,
	onSetModel,
	onSetThinking,
	onCompact,
	streaming = false,
	steering = [],
	followUp = [],
	commands = [],
	draftRequest = null,
	toast = (() => {}) as any,
	onSend = async () => false,
	onAbort = () => {},
	dialogs,
	onDialogDismiss,
	runningWorkflows = 0,
	subagentCount = 0,
}: Props) {
	const model = agentState?.model ?? null;
	const thinking = agentState?.thinkingLevel ?? "off";

	return (
		<footer className="flex flex-col w-full font-mono border-t session-footer shrink-0 border-line bg-bg relative overflow-visible">
			<div className="py-3 px-4 w-full bg-bg">
				<div className="w-full">
					<Composer
						streaming={streaming}
						steering={steering}
						followUp={followUp}
						commands={commands}
						agentState={agentState}
						stats={stats}
						models={models ?? []}
						thinkingLevels={thinkingLevels ?? []}
						draftRequest={draftRequest}
						toast={toast}
						onSend={onSend}
						onAbort={onAbort}
						onSetModel={onSetModel ?? (() => {})}
						onSetThinking={onSetThinking ?? (() => {})}
						onCompact={onCompact ?? (() => {})}
						dialogs={dialogs}
						onDialogDismiss={onDialogDismiss}
					/>
				</div>
			</div>

			{/* Status row: session controls · spacer · context · mcp/subagents/workflows */}
			<div className="relative z-10 flex gap-4 items-center py-2 px-5 w-full font-mono leading-none border-t border-line bg-inset/35 text-[15px] text-dim overflow-visible">
				<div className="flex gap-4 items-center shrink-0">
					<span className="flex items-center tui-footer-control">
						<PermissionModePicker />
					</span>
					<span className="shrink-0 text-dim/30">·</span>
					<span className="flex items-center tui-footer-control">
						<ModelPicker
							models={models ?? []}
							current={model}
							disabled={!models?.length}
							onSelect={onSetModel ?? (() => {})}
						/>
					</span>
					<span className="shrink-0 text-dim/30">·</span>
					<span className="flex items-center tui-footer-control">
						<ThinkingPicker
							current={thinking}
							available={
								thinkingLevels?.length
									? thinkingLevels
									: undefined
							}
							disabled={!agentState}
							onSelect={onSetThinking ?? (() => {})}
						/>
					</span>
					<span className="shrink-0 text-dim/30">·</span>
					<span className="flex items-center shrink-0 h-[14px]">
						<ThroughputBars active={streaming} />
					</span>
				</div>

				<div className="flex-1" />

				<div className="flex gap-4 items-center shrink-0">
					<span className="flex gap-1.5 items-center tabular-nums shrink-0">
						<span className="tui-footer-control">
							<StatsPopover stats={stats} hasSession={!!agentState} onCompact={onCompact ?? (() => {})} />
						</span>
						<span>{fmtContext(stats)}</span>
					</span>
					<span className="shrink-0 text-dim/30">·</span>
					<span className="tabular-nums shrink-0">MCP: 0</span>
					{subagentCount > 0 && (
						<>
							<span className="shrink-0 text-dim/30">·</span>
							<span className="tabular-nums shrink-0">
								subagents: {subagentCount}
							</span>
						</>
					)}
					{runningWorkflows > 0 && (
						<>
							<span className="shrink-0 text-dim/30">·</span>
							<span className="tabular-nums shrink-0">
								workflows: {runningWorkflows}
							</span>
						</>
					)}
				</div>
			</div>

			<style>{`
				.session-footer{position:relative;z-index:20;isolation:isolate}
				.throughput-bars{height:14px;align-items:flex-end}
				.throughput-bar{display:inline-block;width:2px;border-radius:1px;background:currentColor;opacity:0.9;transform-origin:bottom center}
				.throughput-bar.is-idle{height:3px;opacity:0.35}
				.throughput-bar.is-active{animation:throughput-bar 560ms ease-in-out infinite alternate}
				@keyframes throughput-bar{0%{height:3px;opacity:0.6}50%{height:11px;opacity:1}100%{height:5px;opacity:0.8}}
				@media (prefers-reduced-motion: reduce){.throughput-bar.is-active{animation:none;height:5px;opacity:0.7}}
				.session-footer .operator-popover{z-index:70}
				.session-footer .composer-dock { padding: 0; }
				.session-footer .composer-surface { border-radius: 0; box-shadow: none; }
				.session-footer .tui-footer-control .operator-meta-control {
					height: 28px !important;
					min-height: 28px !important;
					padding: 0 8px !important;
					font-family: var(--mono) !important;
					font-size: 15px !important;
					line-height: 1 !important;
					gap: 6px !important;
					color: inherit !important;
					background: transparent !important;
					border: 0 !important;
					border-radius: 0 !important;
					box-shadow: none !important;
				}
				.session-footer .tui-footer-control .operator-meta-control * {
					font-size: 15px !important;
					line-height: 1 !important;
				}
				.session-footer .tui-footer-control .operator-meta-control svg {
					width: 15px !important;
					height: 15px !important;
					flex-shrink: 0;
				}
				.session-footer .tui-footer-control .operator-meta-control:hover {
					color: var(--fg) !important;
					background: transparent !important;
					text-decoration: underline;
					text-underline-offset: 2px;
				}
			`}</style>
		</footer>
	);
}
