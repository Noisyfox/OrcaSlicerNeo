import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { usePlatform } from '@orca/platform-contract';
import type { LayerHeightAction, LayerHeightEditResult, LayerHeightFrame } from '@slicer/client';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { Button } from '@/components/ui/button';
import { runProjectHistoryMutation } from '../../../actions/historyMutation';
import { refreshAfterModelMutation } from '../../../objectList/actions';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { BrushQueue } from './BrushQueue';
import { HeightBar } from './HeightBar';
import { releaseLayerTexture } from './LayerMaterial';
import { useLayerHeight } from './state';

function display(frame: LayerHeightFrame | null) {
  const old = useLayerHeight.getState().frame;
  useLayerHeight.setState({ frame });
  if (old !== frame) releaseLayerTexture(old);
}

export function LayerHeightEditor({ scene, viewport }: { scene: SceneInteractionController; viewport: HTMLElement | null }) {
  const subscribe = useCallback((notify: () => void) => scene.subscribe(notify), [scene]);
  const objectId = useSyncExternalStore(subscribe, () => scene.gizmo === 'layer-height' ? scene.layerHeightObjectId : null);
  const plateId = usePlateSessionStore(s => s.snapshot?.currentPlateId);
  if (objectId === null || !plateId) return null;
  return <TargetEditor key={`${objectId}/${plateId}`} scene={scene} objectId={objectId} plateId={plateId} viewport={viewport} />;
}

function TargetEditor({ scene, objectId, plateId, viewport }: {
  scene: SceneInteractionController; objectId: number; plateId: string; viewport: HTMLElement | null;
}) {
  const { runtime } = usePlatform();
  const { quality, radius, keepMin, busy, frame } = useLayerHeight();
  const revision = useHistoryNavigationStore(s => s.status?.revision);
  const inputRevision = usePlateSessionStore(s => s.snapshot?.inputRevisions?.[plateId]);
  const generation = useProjectStore(s => s.projectGeneration);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const stroke = useRef<BrushQueue | null>(null);
  const mounted = useRef(false);
  const current = frame?.profile.objectId === objectId && frame.profile.stamp.plateId === plateId ? frame : null;

  const cancel = useCallback(() => {
    const active = stroke.current;
    if (!active) return;
    stroke.current = null;
    void active.cancel().catch(() => {}).finally(() => {
      if (mounted.current) setRefresh(value => value + 1);
    });
    useLayerHeight.setState({ busy: false });
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
      display(null);
      useLayerHeight.setState({ cursor: null });
    };
  }, [cancel]);
  useEffect(() => {
    let valid = true;
    cancel();
    setError('');
    void runtime.previewLayerHeight({ objectId, plateId }).then(next => {
      if (valid) display(next);
    }).catch(reason => { if (valid) { display(null); setError(String(reason)); } });
    return () => { valid = false; };
  }, [runtime, objectId, plateId, generation, revision, inputRevision, refresh, cancel]);

  async function mutation(label: string, edit: () => Promise<LayerHeightEditResult>) {
    try {
      await runProjectHistoryMutation(runtime, label, edit, scene, {
        publish: async result => {
          if (result.ok && result.changed) await refreshAfterModelMutation(runtime, result.plateSession);
        },
      });
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally {
      useLayerHeight.setState({ busy: false });
      if (mounted.current) setRefresh(value => value + 1);
    }
  }
  function action(label: string, command: LayerHeightAction) {
    if (!current || useLayerHeight.getState().busy) return;
    useLayerHeight.setState({ busy: true });
    void mutation(label, () => runtime.editLayerHeight({ objectId, plateId, stamp: current.profile.stamp, ...command }));
  }
  return <section aria-label="Variable layer height" data-layer-height-control className="grid gap-2 text-sm">
    <h3 className="font-semibold">Variable layer height</h3>
    <label>Quality / Speed <output>{quality.toFixed(2)}</output>
      <input className="block w-full" type="range" min="0" max="1" step=".01" value={quality}
        onChange={e => useLayerHeight.setState({ quality: Number(e.target.value) })} /></label>
    <Button disabled={!current || busy} onClick={() => action('Adaptive layer height', { operation: 'adaptive', quality })}>Adaptive</Button>
    <label>Smoothing radius <output>{radius}</output>
      <input className="block w-full" type="range" min="1" max="10" step="1" value={radius}
        onChange={e => useLayerHeight.setState({ radius: Number(e.target.value) })} /></label>
    <label><input type="checkbox" checked={keepMin} onChange={e => useLayerHeight.setState({ keepMin: e.target.checked })} /> Keep min</label>
    <Button disabled={!current || busy} onClick={() => action('Smooth layer height', { operation: 'smooth', radius, keepMin })}>Smooth</Button>
    <div className="flex gap-2">
      <Button variant="outline" disabled={!current?.profile.canReset || busy} onClick={() => action('Reset layer height', { operation: 'reset' })}>Reset</Button>
      <Button disabled={busy} onClick={() => scene.closeGizmo()}>Done</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    {current && viewport && createPortal(<HeightBar frame={current} cancel={cancel}
      begin={() => {
        if (useLayerHeight.getState().busy) return false;
        useLayerHeight.setState({ busy: true });
        const active = new BrushQueue(runtime, current.profile, next => {
          if (stroke.current === active && mounted.current) display(next);
        });
        stroke.current = active;
        return true;
      }}
      append={sample => {
        const active = stroke.current;
        void active?.append(sample)?.catch(reason => {
          if (active === stroke.current) { setError(String(reason)); cancel(); }
        });
      }}
      release={() => {
        const active = stroke.current;
        if (!active) return;
        void active.release().then(target => {
          if (stroke.current !== active) return;
          stroke.current = null;
          return mutation('Brush layer height', () => runtime.finishLayerHeightStroke(target));
        }).catch(reason => { if (mounted.current) setError(String(reason)); cancel(); });
      }} />, viewport)}
  </section>;
}
