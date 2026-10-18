import { configVectorElementAt } from '@slicer/client';
import type { PresetDraftSnapshot } from '@slicer/client';
import { EditorSelector } from './EditorSelector';
import type { usePrinterEditorSelection } from './editorSelection';

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
    if (index === undefined) return <div data-testid="preset-editor-extruder-switch" />;
    const available = choices.filter(choice => choice.extruderIndex === index)
      .map(choice => {
        const label = choice.flowType === 0 ? 'Standard' : 'High Flow';
        return { id: choice.id, label, primary: label, testId: `preset-editor-flow-option-${index + 1}-${choice.flowType}` };
      });
    return <div data-testid="preset-editor-extruder-switch"><EditorSelector mode="flat"
      items={available} choiceId={selection.choiceId} disabled={disabled}
      testId={`preset-editor-flow-${index + 1}`} label="Printer editing flow"
      dirtyChoiceIds={dirtyChoiceIds}
      onSelect={id => { const choice = choices.find(choice => choice.id === id); if (choice) selection.selectFlow(choice); }} /></div>;
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
