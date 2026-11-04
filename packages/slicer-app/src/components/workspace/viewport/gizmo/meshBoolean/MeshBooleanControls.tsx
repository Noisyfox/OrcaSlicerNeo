import { useEffect, useMemo } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import * as THREE from 'three';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { loadMeshBooleanPreferences, setMeshBooleanKeepPainting, useMeshBooleanStore } from '@/stores/useMeshBooleanStore';
import { useObjectListStore } from '../../../objectList/useObjectListStore';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { useSceneInteraction, useSceneInteractionVersion } from '../../SceneInteractionContext';
import { selectionBoundsBoxPositions } from '../../SelectionBoundsBox';
import { executeMeshBoolean } from './meshBooleanCommand';

export function MeshBooleanPanel({ sceneInteraction: scene }: { sceneInteraction: SceneInteractionController | null }) {
  const platform = usePlatform();
  useSceneInteractionVersion(scene ?? undefined);
  const { busy, ready, keepPainting } = useMeshBooleanStore();
  const structure = useObjectListStore(s => s.structure);
  useEffect(() => { void loadMeshBooleanPreferences(platform.preferences); }, [platform.preferences]);
  if (!scene || scene.gizmo !== 'mesh-boolean') return null;
  const session = scene.meshBoolean, state = session.getSnapshot();
  const object = structure.find(item => item.id === state.target?.objectId);
  const deleteInput = state.operation === 'difference' ? state.deleteDifference : state.deleteIntersection;
  return <section className="space-y-3" aria-label="Mesh Boolean" data-testid="mesh-boolean-panel">
    <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Mesh Boolean</h3>
      <Button size="icon" variant="ghost" aria-label="Close Mesh Boolean" onClick={() => scene.closeGizmo()}><X /></Button></div>
    <div className="flex flex-wrap gap-1" role="group" aria-label="Boolean operation">
      {(['union', 'difference', 'intersection'] as const).map(operation => <Button key={operation} size="sm"
        variant={state.operation === operation ? 'secondary' : 'ghost'} aria-pressed={state.operation === operation}
        onClick={() => session.setOperation(operation)}>{operation[0].toUpperCase() + operation.slice(1)}</Button>)}
    </div>
    {(['a', 'b'] as const).map(slot => <div key={slot} className="flex min-w-0 gap-1">
      <Button variant={state.picking === slot ? 'secondary' : 'outline'} className="min-w-0 flex-1 justify-start"
        aria-pressed={state.picking === slot} aria-label={`Pick operand ${slot.toUpperCase()}`}
        data-testid={`mesh-boolean-slot-${slot}`} onClick={() => session.setPicking(slot)}>
        <span className={slot === 'a' ? 'text-blue-500' : 'text-orange-500'}>{slot.toUpperCase()}</span>
        <span className="truncate">{object?.volumes.find(item => item.id === state[slot])?.name ?? 'Select a Part'}</span>
      </Button>
      <Button size="icon" variant="ghost" aria-label={`Clear operand ${slot.toUpperCase()}`} disabled={state[slot] === null}
        onClick={() => session.clear(slot)}><X /></Button>
    </div>)}
    <p className="text-xs text-muted-foreground">Choose Parts in the viewport or Object List. A and B must belong to this object.</p>
    {state.operation !== 'union' && <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={deleteInput} onChange={event => session.setDeleteInput(event.target.checked)} />Delete input B
    </label>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={keepPainting} disabled={!ready || busy}
      onChange={event => { void setMeshBooleanKeepPainting(platform.preferences, event.target.checked); }} />Keep painting
    </label>
    <Button className="w-full" disabled={!ready || busy || !session.request(keepPainting)} data-testid="mesh-boolean-execute"
      onClick={() => { const request = session.request(keepPainting); if (request) void executeMeshBoolean(platform, request, scene); }}>
      {state.operation === 'difference' ? 'Subtract B from A' : state.operation === 'intersection' ? 'Intersect A and B' : 'Union A and B'}
    </Button>
  </section>;
}

/** Bounds are identification only. Geometry continues to come from native meshes. */
export function MeshBooleanBounds() {
  const scene = useSceneInteraction();
  const revision = useSceneInteractionVersion();
  const state = scene.meshBoolean.getSnapshot();
  const geometries = useMemo(() => scene.gizmo !== 'mesh-boolean' ? [] : [state.a, state.b].map(id => {
    const volume = scene.meshBoolean.volume(id);
    return volume ? new THREE.BufferGeometry().setAttribute('position',
      new THREE.Float32BufferAttribute(selectionBoundsBoxPositions(volume.getWorldBounds()), 3)) : null;
  }), [scene, state, revision]);
  useEffect(() => () => { geometries.forEach(geometry => geometry?.dispose()); }, [geometries]);
  return <>{geometries.map((geometry, index) => geometry && <lineSegments key={index} geometry={geometry}
    frustumCulled={false} raycast={() => undefined}><lineBasicMaterial color={index === 0 ? '#287cff' : '#ff8c2b'} /></lineSegments>)}</>;
}

/** Mounted once at the application root, including while Home/Device is shown. */
export function MeshBooleanWait() {
  const busy = useMeshBooleanStore(s => s.busy);
  useEffect(() => {
    const block = (event: Event) => {
      if (!useMeshBooleanStore.getState().busy) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['keydown', 'keyup', 'click', 'dblclick', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'contextmenu', 'drop', 'dragover'];
    for (const event of events) window.addEventListener(event, block, { capture: true, passive: false });
    return () => { for (const event of events) window.removeEventListener(event, block, true); };
  }, []);
  return <Dialog open={busy} disablePointerDismissal onOpenChange={() => {}}>
    <DialogContent data-testid="mesh-boolean-wait" className="max-w-sm" aria-busy="true">
      <DialogTitle>Mesh Boolean</DialogTitle>
      <div role="progressbar" aria-label="Computing Mesh Boolean" className="flex items-center gap-3">
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" /><span>Processing…</span>
      </div>
      <DialogDescription>Applying the result. Please wait.</DialogDescription>
    </DialogContent>
  </Dialog>;
}
