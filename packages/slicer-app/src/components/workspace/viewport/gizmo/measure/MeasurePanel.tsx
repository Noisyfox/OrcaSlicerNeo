import { useState } from 'react';
import { Copy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { useSceneInteractionVersion } from '../../SceneInteractionContext';
import { useMeasureController, useMeasureState } from './MeasureProvider';
import { describeMeasureSelection, measureRows, type MeasureRow } from './measurePresentation';

export function MeasurePanel({ sceneInteraction: scene }: { sceneInteraction: SceneInteractionController | null }) {
  useSceneInteractionVersion(scene ?? undefined);
  const controller = useMeasureController();
  const state = useMeasureState();
  const [copyError, setCopyError] = useState<string | null>(null);
  if (!scene || scene.gizmo !== 'measure' || !controller || !state) return null;
  const status = state.status;
  const copy = (row: MeasureRow) => {
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      void navigator.clipboard.writeText(`${row.label}: ${row.value}`).catch(() => setCopyError('Could not copy measurement.'));
    } catch { setCopyError('Could not copy measurement.'); }
  };
  return <section className="space-y-3" aria-label="Measure" data-testid="measure-panel" data-phase={state.phase} data-session-id={status?.sessionId}>
    <div className="flex items-center justify-between">
      <h2 className="text-module font-semibold uppercase tracking-wide text-muted-foreground">Measure</h2>
      <Button size="icon" variant="ghost" aria-label="Close Measure" onClick={() => scene.closeGizmo()}><X /></Button>
    </div>
    {state.phase === 'opening' && <p role="status" className="text-xs text-muted-foreground">Preparing measurement…</p>}
    {state.phase === 'rebasing' && <p role="status" className="text-xs text-muted-foreground">Updating measurement…</p>}
    {([['first', 'Selection 1'], ['second', 'Selection 2']] as const).map(([slot, label]) => {
      const item = status?.[slot] ?? null;
      return <div key={slot} className="flex items-center gap-1 text-xs" data-testid={`measure-${slot}`}>
        <span className="shrink-0 text-muted-foreground">{label}</span>
        <span className="min-w-0 flex-1 break-words">{describeMeasureSelection(item)}</span>
        <Button size="icon-xs" variant="ghost" aria-label={`Reset ${label}`} disabled={!item || state.phase !== 'idle'}
          onClick={() => controller.reset(slot)}><X /></Button>
      </div>;
    })}
    {measureRows(status).map(row => <div key={row.label} className="flex items-center gap-1 text-xs" data-testid="measure-result">
      <span className="min-w-0 flex-1 break-words"><span className="text-muted-foreground">{row.label}: </span>{row.value}</span>
      <Button size="icon-xs" variant="ghost" aria-label={`Copy ${row.label}`} onClick={() => copy(row)}><Copy /></Button>
    </div>)}
    {(state.error || copyError) && <p role="alert" className="text-xs text-destructive">{copyError ?? state.error}</p>}
    <p className="text-xs text-muted-foreground">Select up to two features. Shift-click selects a point on a feature.</p>
    <Button className="w-full" variant="secondary" onClick={() => scene.closeGizmo()}>Done</Button>
  </section>;
}
