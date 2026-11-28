import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { CutRequest, CutSideAction } from '@slicer/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { useSceneInteractionVersion } from '../../SceneInteractionContext';
import { captureTransformReservationState } from '../../../actions/historyMutation';
import { applyCut } from './cutCommand';

export function CutPanel({ scene }: { scene: SceneInteractionController }) {
  const platform = usePlatform();
  useSceneInteractionVersion(scene);
  const cut = scene.cut, target = cut.target, draft = cut.draft;
  const snapshot = usePlateSessionStore(s => s.snapshot);
  const [text, setText] = useState('');
  const [repair, setRepair] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setText(draft ? String(Number(draft.center[2].toFixed(4))) : ''); }, [draft?.center[2], target]);
  useEffect(() => { setError(''); setRepair(false); }, [target]);
  useEffect(() => {
    if (!target || cut.revision !== null) return;
    let live = true;
    void captureTransformReservationState(platform.runtime)
      .then(({ status }) => { if (live) cut.setRevision(target, status.revision); })
      .catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [cut, target, platform.runtime]);
  if (scene.gizmo !== 'cut' || !draft || !target) return null;
  const instances = snapshot?.instances?.filter(i => i.objectId === target.objectId) ?? [];
  const plates = new Set(instances.filter(i => i.member).map(i => i.plateId)).size;
  const commitHeight = () => {
    const z = Number(text);
    if (text.trim() && Number.isFinite(z)) cut.update({ center: [draft.center[0], draft.center[1], z] });
    else setText(String(draft.center[2]));
  };
  const perform = async (openEdges: CutRequest['openEdges']) => {
    if (cut.busy || cut.revision === null) return;
    cut.setBusy(true); setError('');
    try {
      const result = await applyCut(platform, { ...draft, objectId: target.objectId, instanceId: target.instanceId,
        revision: cut.revision, openEdges }, scene);
      if (!result.ok) setError(result.error);
      else if (!result.changed) setRepair(true);
      else { cut.close(false); scene.closeGizmo(); }
    } finally {
      cut.setBusy(false);
      if (!cut.target && scene.gizmo === 'cut') scene.closeGizmo();
    }
  };
  return <section aria-label="Cut" data-testid="cut-panel" className="space-y-3 text-sm">
    <h2 className="text-module font-semibold">Cut</h2>
    {instances.length > 1 && <p>Applies to {instances.length} instances on {plates} {plates === 1 ? 'plate' : 'plates'}.</p>}
    <fieldset disabled={cut.busy || repair} className="space-y-3">
      <label className="flex items-center justify-between gap-2">Cut position Z (mm)
        <input aria-label="Cut position Z" className="w-20 rounded border px-2 py-1" type="number" step="any"
          value={text} onChange={e => setText(e.target.value)} onBlur={commitHeight}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>
      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => cut.flip()}>Flip plane</Button>
        <Button size="sm" variant="outline" onClick={() => cut.update(target.initial)}>Reset plane</Button></div>
      {draft.grouping && <p data-testid="cut-piece-count">{draft.grouping.toggled.length} reassigned</p>}
      <label className="flex gap-2"><input type="checkbox" disabled={!!draft.grouping} checked={draft.asParts}
        onChange={e => cut.update({ asParts: e.target.checked })}/>Cut to parts</label>
      {!draft.asParts && (['upper','lower'] as const).map((side, i) =>
        <label key={side} className="flex items-center justify-between gap-2">Side {i === 0 ? 'A' : 'B'}
          <select aria-label={i === 0 ? 'Side A' : 'Side B'} value={draft[side]}
            onChange={e => cut.update({ [side]: e.target.value as CutSideAction })}>
            <option value="keep">Keep orientation</option><option value="place">Place on cut</option>
            <option value="flip">Flip</option><option value="discard">Discard</option>
          </select></label>)}
      <div className="flex gap-2"><Button size="sm" disabled={cut.revision === null || (draft.upper === 'discard' && draft.lower === 'discard')}
        onClick={() => void perform('ask')}>Perform cut</Button>
        <Button size="sm" variant="outline" onClick={() => { cut.close(false); scene.closeGizmo(); }}>Cancel</Button></div>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <Dialog open={repair}><DialogContent>
      <DialogTitle>Open edges in cut results</DialogTitle>
      <DialogDescription>Some result volumes have open edges. Choose how to apply this cut.</DialogDescription>
      <Button onClick={() => { setRepair(false); void perform('repair'); }}>Repair and apply</Button>
      <Button variant="outline" onClick={() => { setRepair(false); void perform('apply'); }}>Apply directly</Button>
    </DialogContent></Dialog>
  </section>;
}
