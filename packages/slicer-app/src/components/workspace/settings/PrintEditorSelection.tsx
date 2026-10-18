import type { ConfigEditorChoice, ConfigEditorSelection } from '@slicer/client';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { EditorSelector } from './EditorSelector';

// Native NozzleVolumeType labels, not vector-index or variant calculations.
export function printChoiceFlow(choice: ConfigEditorChoice): string {
  return ({ 0: 'SF', 1: 'HF', 2: 'Hybrid', 3: 'TPU HF', 5: 'E3D HF', 6: 'XHF' } as Record<number, string>)[choice.flowType ?? -1] ?? choice.variant;
}

export function PrintEditorSelection({ metadata, choiceId, onSelect, disabled, dirtyChoiceIds }: {
  dirtyChoiceIds: ReadonlySet<string>;
  metadata: ConfigEditorSelection;
  choiceId: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
}) {
  const diameters = useSettingsStore(state => state.values.nozzle_diameter)?.split(',').map(value => value.trim()) ?? [];
  const items = metadata.choices.map(choice => {
    const diameter = choice.extruderIndex === null ? '—' : diameters[choice.extruderIndex] ?? diameters[0] ?? '—';
    return { id: choice.id, label: choice.label, primary: choice.extruderIndex === null ? '—' : choice.extruderIndex + 1,
      secondary: `${diameter} ${printChoiceFlow(choice)}`, title: `${choice.label}: ${diameter} mm ${printChoiceFlow(choice)}` };
  });
  return <EditorSelector mode="flat" items={items} choiceId={choiceId} onSelect={onSelect} disabled={disabled}
    label="Print nozzle" testId="print-editor-selection" dirtyChoiceIds={dirtyChoiceIds} width="full" />;
}
