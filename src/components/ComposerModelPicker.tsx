import ModelPicker, { type PickerModel as Model } from "./ModelPicker";

export { MODEL_PICKER_SHORTCUT_LIMIT } from "./ModelPicker";

interface Props {
	models: Model[];
	current?: Model | null;
	disabled?: boolean;
	onSelect(provider: string, modelId: string): void;
}

/**
 * Composer preset of the shared ModelPicker: denser trigger for the
 * controls row, panel opening upward above the input. The full
 * implementation lives in ./ModelPicker (single owner for search, tabs,
 * recents, keyboard, and quick-select behavior).
 */
export default function ComposerModelPicker({
	models,
	current,
	disabled,
	onSelect,
}: Props) {
	return (
		<ModelPicker
			models={models}
			current={current}
			disabled={disabled}
			onSelect={onSelect}
			side="top"
			compactTrigger
		/>
	);
}
