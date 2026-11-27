import { beginLayerHeightProbe, recordLayerHeightSample, registerLayerHeightProbe, releaseLayerHeightProbe } from '@/e2e/layerHeightProbe';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { usePlatform } from '@orca/platform-contract';
import type { LayerHeightAction, LayerHeightEditResult, LayerHeightFrame } from '@slicer/client';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { runProjectHistoryMutation } from '../../../actions/historyMutation';
import { publishModelPlateMutation } from '../../../objectList/actions';
import type { SceneInteractionController } from '../../SceneInteractionController';
import { BrushQueue } from './BrushQueue';
import { HeightBar } from './HeightBar';
import { releaseLayerTexture } from './LayerMaterial';
import { useLayerHeight } from './state';

declare const __ORCA_E2E__: boolean;

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
  const restoring = useHistoryRestoreStore(s => s.phase !== 'idle');
  const locked = busy || restoring;
  const revision = useHistoryNavigationStore(s => s.status?.revision);
  const inputRevision = usePlateSessionStore(s => s.snapshot?.inputRevisions?.[plateId]);
  const generation = useProjectStore(s => s.projectGeneration);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const stroke = useRef<BrushQueue | null>(null);
  const mounted = useRef(false);
  const current = frame?.profile.objectId === objectId && frame.profile.stamp.plateId === plateId ? frame : null;

  useEffect(() => {
    if (__ORCA_E2E__) return registerLayerHeightProbe(runtime, () => useLayerHeight.getState().frame);
  }, [runtime]);

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
    if (restoring) return;
    void runtime.previewLayerHeight({ objectId, plateId }).then(next => {
      if (valid) display(next);
    }).catch(reason => { if (valid) { display(null); setError(String(reason)); } });
    return () => { valid = false; };
  }, [runtime, objectId, plateId, generation, revision, inputRevision, refresh, restoring, cancel]);

  async function mutation(label: string, edit: () => Promise<LayerHeightEditResult>) {
    try {
      await runProjectHistoryMutation(runtime, label, edit, scene, {
        publish: async result => {
          if (result.ok && result.changed) await publishModelPlateMutation(runtime, result.plateSession);
        },
      });
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally {
      useLayerHeight.setState({ busy: false });
      if (mounted.current) setRefresh(value => value + 1);
    }
  }
  function action(label: string, command: LayerHeightAction) {
    if (!current || restoring || useLayerHeight.getState().busy) return;
    useLayerHeight.setState({ busy: true });
    void mutation(label, () => runtime.editLayerHeight({ objectId, plateId, stamp: current.profile.stamp, ...command }));
  }
  return <section aria-label="Variable layer height" data-layer-height-control className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_4ch] items-center gap-x-2 gap-y-3 text-sm">
    <div className="col-span-full flex items-center justify-between gap-2">
      <h2 className="text-module font-semibold">Variable layer height</h2>
      <Button size="sm" variant="ghost" disabled={locked} onClick={() => scene.closeGizmo()}>Done</Button>
    </div>
    <span className="text-muted-foreground">Quality / Speed</span>
    <Slider aria-label="Quality / Speed" value={[quality]} min={0} max={1} step={0.01}
      onValueChange={value => useLayerHeight.setState({ quality: Array.isArray(value) ? value[0] : value })} />
    <output className="text-right tabular-nums">{quality.toFixed(2)}</output>
    <Button size="sm" variant="secondary" className="col-span-full" disabled={!current || locked}
      onClick={() => action('Adaptive layer height', { operation: 'adaptive', quality })}>Adaptive</Button>
    <span className="text-muted-foreground">Smoothing radius</span>
    <Slider aria-label="Smoothing radius" value={[radius]} min={1} max={10} step={1}
      onValueChange={value => useLayerHeight.setState({ radius: Array.isArray(value) ? value[0] : value })} />
    <output className="text-right tabular-nums">{radius}</output>
    <Label className="col-span-full"><Checkbox checked={keepMin} onCheckedChange={checked => useLayerHeight.setState({ keepMin: checked })} />Keep min</Label>
    <div className="col-span-full flex gap-2">
      <Button size="sm" variant="secondary" className="flex-1" disabled={!current || locked}
        onClick={() => action('Smooth layer height', { operation: 'smooth', radius, keepMin })}>Smooth</Button>
      <Button size="sm" variant="outline" className="flex-1" disabled={!current?.profile.canReset || locked}
        onClick={() => action('Reset layer height', { operation: 'reset' })}>Reset</Button>
    </div>
    {error && <p role="alert" className="col-span-full text-destructive">{error}</p>}
    {current && viewport && createPortal(<HeightBar frame={current} cancel={cancel}
      begin={() => {
        if (restoring || useLayerHeight.getState().busy) return false;
        useLayerHeight.setState({ busy: true });
        if (__ORCA_E2E__) beginLayerHeightProbe(current);
        const active = new BrushQueue(runtime, current.profile, next => {
          if (stroke.current === active && mounted.current) display(next);
        });
        stroke.current = active;
        return true;
      }}
      append={sample => {
        const active = stroke.current;
        if (__ORCA_E2E__ && active) recordLayerHeightSample(sample);
        void active?.append(sample)?.catch(reason => {
          if (active === stroke.current) { setError(String(reason)); cancel(); }
        });
      }}
      release={() => {
        const active = stroke.current;
        if (!active) return;
        if (__ORCA_E2E__) releaseLayerHeightProbe();
        void active.release().then(target => {
          if (stroke.current !== active) return;
          stroke.current = null;
          return mutation('Brush layer height', () => runtime.finishLayerHeightStroke(target));
        }).catch(reason => { if (mounted.current) setError(String(reason)); cancel(); });
      }} />, viewport)}
  </section>;
}
