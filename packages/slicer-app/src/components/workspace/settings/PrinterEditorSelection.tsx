import { useState } from 'react';
import { configVectorElementAt } from '@slicer/client';
import type { ConfigEditorChoice, PresetDraftSnapshot } from '@slicer/client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfigEditorSelection } from './ConfigEditorSelection';

interface PrinterView {
  readonly source: string | null;
  readonly entry: number;
  readonly nozzle: number | null;
  readonly flows: Readonly<Record<number, number | null>>;
}

export function usePrinterEditorSelection(snapshot: PresetDraftSnapshot | null, entry: number) {
  const [view, setView] = useState<PrinterView>({ source: null, entry, nozzle: null, flows: {} });
  let current = view;
  if (snapshot?.kind === 'printer') {
    const metadata = snapshot.editorSelection;
    const initialize = view.source === null || (view.entry !== entry && metadata.activeSource);
    const flows = Object.fromEntries(metadata.nozzles.map(nozzle => {
      const choices = metadata.choices.filter(choice => choice.extruderIndex === nozzle.extruderIndex);
      const retained = choices.find(choice => choice.flowType === view.flows[nozzle.extruderIndex]);
      const fallback = choices.find(choice => choice.id === (initialize ? nozzle.initialChoiceId : nozzle.defaultChoiceId));
      return [nozzle.extruderIndex, (!initialize && retained ? retained : fallback)?.flowType ?? null];
    }));
    const nozzle = metadata.nozzles.some(nozzle => nozzle.extruderIndex === view.nozzle) ? view.nozzle : metadata.nozzles[0]?.extruderIndex ?? null;
    if (view.source !== snapshot.canonicalName || view.entry !== entry || view.nozzle !== nozzle || JSON.stringify(flows) !== JSON.stringify(view.flows)) {
      // Reconcile before rendering fields so a receipt/source change never
      // renders one frame with a stale or unavailable selection.
      current = { source: snapshot.canonicalName, entry, nozzle, flows };
      setView(current);
    }
  } else if (view.source !== null) {
    current = { source: null, entry, nozzle: null, flows: {} };
    setView(current);
  }
  const choiceId = snapshot?.editorSelection.choices.find(choice => choice.extruderIndex === current.nozzle && choice.flowType === current.flows[current.nozzle!])?.id ?? null;
  return { view: current, choiceId,
    selectNozzle: (nozzle: number) => setView(previous => ({ ...previous, nozzle })),
    selectFlow: (choice: ConfigEditorChoice) => setView(previous => ({ ...previous, nozzle: choice.extruderIndex,
      flows: { ...previous.flows, [choice.extruderIndex!]: choice.flowType } })),
  };
}

export function PrinterEditorSelection({ snapshot, selection, disabled, dirtyChoiceIds }: {
  snapshot: PresetDraftSnapshot;
  selection: ReturnType<typeof usePrinterEditorSelection>;
  disabled: boolean;
  dirtyChoiceIds: ReadonlySet<string>;
}) {
  const { nozzles, choices } = snapshot.editorSelection;
  const multiple = nozzles.length > 1;
  const flowSelect = (index: number) => {
    const available = choices.filter(choice => choice.extruderIndex === index);
    const selected = available.find(choice => choice.flowType === selection.view.flows[index]);
    const label = (choice: ConfigEditorChoice) => multiple ? choice.flowType === 0 ? 'SF' : 'HF' : choice.flowType === 0 ? 'Standard' : 'High Flow';
    return <Select value={selected?.id ?? null} disabled={disabled || available.length === 0}
      items={available.map(choice => ({value:choice.id,label:label(choice)}))}
      onValueChange={id => { const choice = available.find(choice => choice.id === id); if (choice) selection.selectFlow(choice); }}>
      <SelectTrigger variant={multiple ? 'sidebar' : 'default'}
        className={multiple ? 'preset-editor-nozzle-flow' : 'w-40'}
        aria-label={multiple ? `Extruder ${index + 1} editing flow` : 'Printer editing flow'} data-testid={`preset-editor-flow-${index + 1}`}>
        <SelectValue>{selected ? label(selected) : 'Unavailable'}</SelectValue>
      </SelectTrigger>
      <SelectContent><SelectGroup>{available.map(choice => <SelectItem key={choice.id} value={choice.id}
        data-testid={`preset-editor-flow-option-${index + 1}-${choice.flowType}`}>{label(choice)}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>;
  };
  if (!multiple) {
    const index = nozzles[0]?.extruderIndex;
    const available = choices.filter(choice => choice.extruderIndex === index)
      .map(choice => ({ ...choice, label: choice.flowType === 0 ? 'Standard' : 'High Flow' }));
    return <div data-testid="preset-editor-extruder-switch">{index !== undefined && <ConfigEditorSelection
      metadata={{ choices: available }} choiceId={selection.choiceId} disabled={disabled}
      testId={`preset-editor-flow-${index + 1}`} label="Printer editing flow"
      dirtyChoiceIds={dirtyChoiceIds}
      itemTestId={choice => `preset-editor-flow-option-${index + 1}-${choice.flowType}`}
      onSelect={id => { const choice = choices.find(choice => choice.id === id); if (choice) selection.selectFlow(choice); }} />}</div>;
  }
  return <div className="printer-toolhead-list w-max max-w-full flex-wrap" role="group" aria-label="Printer extruders" data-testid="preset-editor-extruder-switch">
    {nozzles.map(nozzle => {
      const index = nozzle.extruderIndex;
      const vector = snapshot.editorVectors.nozzle_diameter;
      const diameter = vector ? configVectorElementAt(vector, vector.effectiveValues, index) : undefined;
      const selected = selection.view.nozzle === index;
      return <div key={index} className="printer-nozzle-extruder printer-toolhead preset-editor-toolhead" data-active={selected}>
        <Button type="button" variant="ghost" className="h-7 w-full flex-col gap-0 rounded-none border-0 p-0 text-[13px] leading-[14px] font-normal"
          aria-pressed={selected} aria-label={`Extruder ${index + 1}: ${diameter ?? '—'} mm`}
          data-testid={`preset-editor-extruder-${index + 1}`} disabled={disabled} onClick={() => selection.selectNozzle(index)}>
          <span>{index + 1}</span><span>{typeof diameter === 'number' ? diameter : '—'}</span>
        </Button>
        {flowSelect(index)}
      </div>;
    })}
  </div>;
}
