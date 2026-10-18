import { useState } from 'react';
import type { ConfigEditorChoice, ConfigEditorSelection as Selection } from '@slicer/client';
import { ToggleGroupItem } from '@/components/ui/toggle-group';
import { EditorSelectionStrip } from './EditorSelectionStrip';
import { cn } from 'cn';

// Native IDs may be snapshot-local ordinals. Keep the drive/flow variant and
// physical nozzle identity across refreshed or reordered choices instead.
export const editorChoiceIdentity = (choice: ConfigEditorChoice) => JSON.stringify([choice.extruderIndex, choice.variant]);

export function useConfigEditorSelection(metadata: Selection | null, entry: number) {
  const [view, setView] = useState<{ entry: number; identity: string | null }>({ entry, identity: null });
  const choices = metadata?.choices ?? [];
  const retained = view.entry === entry ? choices.find(choice => editorChoiceIdentity(choice) === view.identity) : undefined;
  const selected = retained ?? choices.find(choice => choice.id === metadata?.firstChoiceId);
  const identity = selected ? editorChoiceIdentity(selected) : metadata ? null : view.entry === entry ? view.identity : null;
  if (view.entry !== entry || (metadata && view.identity !== identity)) setView({ entry, identity });
  return { choiceId: selected?.id ?? null, identity,
    select: (id: string | null) => {
      const choice = choices.find(choice => choice.id === id);
      if (choice) setView({ entry, identity: editorChoiceIdentity(choice) });
    },
  };
}

export function ConfigEditorSelection({ metadata, choiceId, onSelect, disabled, testId, label, itemTestId, dirtyChoiceIds }: {
  metadata: Pick<Selection, 'choices'>;
  choiceId: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
  testId: string;
  label: string;
  itemTestId?: (choice: ConfigEditorChoice) => string;
  dirtyChoiceIds: ReadonlySet<string>;
}) {
  return <EditorSelectionStrip choices={metadata.choices} choiceId={choiceId} onSelect={onSelect}
    disabled={disabled} label={label} testId={testId} fitContent>
    {metadata.choices.map(choice => <ToggleGroupItem key={choice.id} value={choice.id}
      aria-label={choice.label} title={choice.label} data-choice-id={choice.id} data-testid={itemTestId?.(choice)}
      data-dirty={dirtyChoiceIds.has(choice.id) ? 'true' : 'false'}>
      <span className={cn(dirtyChoiceIds.has(choice.id) && 'text-config-override')}>{choice.label}</span>
    </ToggleGroupItem>)}
  </EditorSelectionStrip>;
}
