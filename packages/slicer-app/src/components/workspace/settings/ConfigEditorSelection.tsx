import { useState } from 'react';
import type { ConfigEditorChoice, ConfigEditorSelection as Selection } from '@slicer/client';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Native IDs may be snapshot-local ordinals. Keep the drive/flow variant and
// physical nozzle identity across refreshed or reordered choices instead.
export const editorChoiceIdentity = (choice: ConfigEditorChoice) => JSON.stringify([choice.extruderIndex, choice.variant]);

export function useConfigEditorSelection(metadata: Selection | null, entry: number) {
  const [view, setView] = useState<{ entry: number; identity: string | null }>({ entry, identity: null });
  const choices = metadata?.choices ?? [];
  const retained = view.entry === entry ? choices.find(choice => editorChoiceIdentity(choice) === view.identity) : undefined;
  const selected = retained ?? choices.find(choice => choice.id === metadata?.firstChoiceId);
  const identity = selected ? editorChoiceIdentity(selected) : null;
  if (view.entry !== entry || view.identity !== identity) setView({ entry, identity });
  return { choiceId: selected?.id ?? null, identity,
    select: (id: string | null) => {
      const choice = choices.find(choice => choice.id === id);
      if (choice) setView({ entry, identity: editorChoiceIdentity(choice) });
    },
  };
}

export function ConfigEditorSelection({ metadata, choiceId, onSelect, disabled, testId, label }: {
  metadata: Selection;
  choiceId: string | null;
  onSelect: (id: string | null) => void;
  disabled: boolean;
  testId: string;
  label: string;
}) {
  return <Select value={choiceId} disabled={disabled} onValueChange={onSelect}
    items={metadata.choices.map(choice => ({ value: choice.id, label: choice.label }))}>
    <SelectTrigger className="max-w-full" aria-label={label} data-testid={testId}><SelectValue /></SelectTrigger>
    <SelectContent><SelectGroup>{metadata.choices.map(choice =>
      <SelectItem key={choice.id} value={choice.id}>{choice.label}</SelectItem>)}
    </SelectGroup></SelectContent>
  </Select>;
}
