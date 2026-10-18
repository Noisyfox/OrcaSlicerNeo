import { useState } from 'react';
import { configVectorElementAt } from '@slicer/client';
import type { ConfigEditorChoice, PresetDraftSnapshot } from '@slicer/client';
import { ConfigEditorSelection } from './ConfigEditorSelection';
import { EditorSelector } from './EditorSelector';

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
  const items = nozzles.map(nozzle => {
    const index = nozzle.extruderIndex;
    const vector = snapshot.editorVectors.nozzle_diameter;
    const diameter = vector ? configVectorElementAt(vector, vector.effectiveValues, index) : undefined;
    const available = choices.filter(choice => choice.extruderIndex === index);
    return { id: String(index), label: `Extruder ${index + 1}: ${diameter ?? '—'} mm`, primary: index + 1,
      secondary: typeof diameter === 'number' ? String(diameter) : '—', testId: `preset-editor-extruder-${index + 1}`,
      flowLabel: `Extruder ${index + 1} editing flow`, flowTestId: `preset-editor-flow-${index + 1}`,
      choiceId: available.find(choice => choice.flowType === selection.view.flows[index])?.id ?? null,
      choices: available.map(choice => ({ id: choice.id, label: choice.flowType === 0 ? 'SF' : 'HF',
        testId: `preset-editor-flow-option-${index + 1}-${choice.flowType}` })) };
  });
  return <EditorSelector mode="nozzles" nozzles={items} nozzleId={selection.view.nozzle === null ? null : String(selection.view.nozzle)}
    disabled={disabled} label="Printer extruders" testId="preset-editor-extruder-switch"
    onSelectNozzle={id => { const nozzle = nozzles.find(nozzle => String(nozzle.extruderIndex) === id); if (nozzle) selection.selectNozzle(nozzle.extruderIndex); }}
    onSelectChoice={id => { const choice = choices.find(choice => choice.id === id); if (choice) selection.selectFlow(choice); }} />;
}
