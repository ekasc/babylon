import { useState } from "react";
import Composer, { type Attachment } from "./Composer";
import { GoalStrip } from "./GoalStrip";
import type { PickerModel } from "./ModelPicker";
import type { Stats } from "./StatsPopover";

interface Props {
	agentState?: { model?: PickerModel | null; thinkingLevel?: string } | null;
	stats?: Stats | null;
	models?: PickerModel[];
	thinkingLevels?: string[];
	onSetModel?: (provider: string, modelId: string) => void;
	onSetThinking?: (level: string) => void;
	onCompact?: () => void;
	streaming?: boolean;
	steering?: string[];
	followUp?: string[];
	commands?: any[];
	draftRequest?: { id: number; text: string; append?: boolean } | null;
	/** Session identity for per-session composer draft persistence. */
	sessionKey?: string | null;
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
	/** Bots offered for @-mention completion in the composer. */
	mentionBots?: import("../bots").Bot[];
	/** The session's goal, as a mini strip joined to the top of the composer. */
	goal?: import("../lib/goal-mode").GoalState | null;
	onStartGoal?: (objective: string) => void;
	onPauseGoal?: () => void;
	onResumeGoal?: () => void;
	onFinishGoal?: () => void;
	onClearGoal?: () => void;
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
	sessionKey = null,
	toast = (() => {}) as any,
	onSend = async () => false,
	onAbort = () => {},
	dialogs,
	onDialogDismiss,
	mentionBots = [],
	goal = null,
	onStartGoal = () => {},
	onPauseGoal = () => {},
	onResumeGoal = () => {},
	onFinishGoal = () => {},
	onClearGoal = () => {},
}: Props) {
	const [goalEditing, setGoalEditing] = useState(false);
	// The session controls (permission, model, thinking, run state, usage)
	// live in the composer surface itself. The footer is just the composer,
	// not a permanent telemetry dashboard.

	return (
		<footer className="flex flex-col w-full session-footer shrink-0 bg-bg relative overflow-visible">
			<div className="py-3 px-4 w-full bg-bg">
				{/* Centered column matching the transcript width (768px, T3Code's
				    max-w-3xl for both timeline and composer): the composer reads
				    as one deliberate control surface aligned to the
				    conversation, session controls included. */}
				<div className="mx-auto w-full max-w-3xl">
					{goal || goalEditing ? (
						<GoalStrip
							goal={goal}
							editing={goalEditing}
							onEditingChange={setGoalEditing}
							onStart={(objective) => {
								onStartGoal(objective);
								setGoalEditing(false);
							}}
							onPause={onPauseGoal}
							onResume={onResumeGoal}
							onFinish={onFinishGoal}
							onClear={onClearGoal}
						/>
					) : null}
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
						sessionKey={sessionKey}
						toast={toast}
						onSend={onSend}
						onAbort={onAbort}
						onSetModel={onSetModel ?? (() => {})}
						onSetThinking={onSetThinking ?? (() => {})}
						onCompact={onCompact ?? (() => {})}
						dialogs={dialogs}
						onDialogDismiss={onDialogDismiss}
						mentionBots={mentionBots}
						goalSet={goal !== null}
						onStartGoal={() => setGoalEditing(true)}
					/>
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
				/* In-composer control row: ghost controls one step smaller than
				   the old status strip, so the row reads as composer chrome. */
				.session-footer .composer-controls-row .operator-meta-control {
					height: 26px !important;
					min-height: 26px !important;
					padding: 0 8px !important;
					font-family: var(--font-sans) !important;
					font-size: 12.5px !important;
					line-height: 1 !important;
					gap: 6px !important;
					color: inherit !important;
					background: transparent !important;
					border: 0 !important;
					border-radius: 7px !important;
					box-shadow: none !important;
				}
				.session-footer .composer-controls-row .operator-meta-control * {
					font-size: 12.5px !important;
					line-height: 1 !important;
				}
				.session-footer .composer-controls-row .operator-meta-control svg {
					width: 12px !important;
					height: 12px !important;
					flex-shrink: 0;
				}
				.session-footer .composer-controls-row .operator-meta-control:hover {
					color: var(--fg) !important;
					background: transparent !important;
					text-decoration: underline;
					text-underline-offset: 2px;
				}
				/* The model control is the flexible truncating region: every
				   flex level needs min-width:0 or the long name pushes thinking
				   and context out of position. All other controls are shrink-0
				   and never move. */
				.session-footer .composer-controls-row .model-shrink,
				.session-footer .composer-controls-row .model-shrink > div,
				.session-footer .composer-controls-row .model-shrink .operator-meta-control {
					min-width: 0 !important;
				}
				.session-footer .composer-controls-row .model-shrink .operator-meta-control {
					max-width: 100%;
				}
			`}</style>
		</footer>
	);
}
