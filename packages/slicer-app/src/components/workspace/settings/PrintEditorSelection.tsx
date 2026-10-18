import type { ConfigEditorChoice, ConfigEditorSelection } from '@slicer/client';
import { ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { cn } from 'cn';
import { EditorSelectionStrip } from './EditorSelectionStrip';

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
  return <EditorSelectionStrip choices={metadata.choices} choiceId={choiceId} onSelect={onSelect}
    disabled={disabled} label="Print nozzle" testId="print-editor-selection">
    {metadata.choices.map(choice => {
      const diameter = choice.extruderIndex === null ? '—' : diameters[choice.extruderIndex] ?? diameters[0] ?? '—';
      const dirty = dirtyChoiceIds.has(choice.id);
      return <ToggleGroupItem key={choice.id} value={choice.id} aria-label={choice.label} title={`${choice.label}: ${diameter} mm ${printChoiceFlow(choice)}`}
        data-choice-id={choice.id} data-dirty={dirty ? 'true' : 'false'}>
        <span className="flex flex-col items-center">
          <span className={cn(dirty ? 'text-config-override' : 'text-foreground')}>{choice.extruderIndex === null ? '—' : choice.extruderIndex + 1}</span>
          <span className={cn(dirty ? 'text-config-override' : 'text-muted-foreground')}>{diameter} {printChoiceFlow(choice)}</span>
        </span>
      </ToggleGroupItem>;
    })}
  </EditorSelectionStrip>;
}
