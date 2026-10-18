import { useState } from 'react';
import type { ConfigEditorChoice, ConfigEditorSelection, PresetDraftSnapshot } from '@slicer/client';

/** Callers choose their visible/search fields; native bindings decide applicability. */
export function isEditorSelectionVisible(metadata: ConfigEditorSelection | null | undefined, visibleKeys: readonly string[]): boolean {
  if (!metadata || (metadata.choices.length <= 1 && (metadata.kind !== 'printer' || metadata.nozzles.length <= 1))) return false;
  return visibleKeys.some(key => metadata.fieldBindings[key]?.kind === 'per_selection');
}

// Native IDs may be snapshot-local ordinals. Keep the drive/flow variant and
// physical nozzle identity across refreshed or reordered choices instead.
export const editorChoiceIdentity = (choice: ConfigEditorChoice) => JSON.stringify([choice.extruderIndex, choice.variant]);

export function useConfigEditorSelection(metadata: ConfigEditorSelection | null, entry: number) {
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

interface PrinterView {
  readonly source: string | null;
  readonly entry: number;
  readonly nozzle: number | null;
  readonly flows: Readonly<Record<number, number | null>>;
}

/** Printer flows have their own native initialization and per-nozzle retention policy. */
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
