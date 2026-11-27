import type { LayerHeightFrame, LayerHeightSample } from '@slicer/client';
import type { SlicerRuntime } from '@orca/platform-contract';
import { registerOrcaE2eOwnerAfterPassiveEffects } from './registerOrcaE2e';

type Stroke = {
  base: LayerHeightFrame;
  started: number;
  samples: LayerHeightSample[];
  held: boolean;
  latencyMs: number | null;
  visible: LayerHeightFrame | null;
  captured: LayerHeightFrame | null;
};
let stroke: Stroke | null = null;
const paints = new WeakMap<LayerHeightFrame, { bar?: boolean; model?: boolean }>();

export function beginLayerHeightProbe(base: LayerHeightFrame) {
  stroke = { base, started: performance.now(), samples: [], held: true, latencyMs: null, visible: null, captured: null };
}
export function recordLayerHeightSample(sample: LayerHeightSample) {
  stroke?.samples.push({ ...sample });
}
export function releaseLayerHeightProbe() {
  if (stroke) stroke.held = false;
}
export function recordLayerHeightPaint(frame: LayerHeightFrame, surface: 'bar' | 'model') {
  if (!stroke || frame === stroke.base) return;
  const seen = paints.get(frame) ?? {};
  seen[surface] = true;
  paints.set(frame, seen);
  if (seen.bar && seen.model) {
    stroke.visible = frame;
    if (stroke.held && stroke.latencyMs === null) stroke.latencyMs = performance.now() - stroke.started;
  }
}

export function registerLayerHeightProbe(runtime: SlicerRuntime, current: () => LayerHeightFrame | null) {
  const unregister = registerOrcaE2eOwnerAfterPassiveEffects('layer-height', {
    layerHeightLiveLatency: () => stroke?.latencyMs ?? null,
    captureLayerHeightFrame: () => {
      const frame = current();
      if (!stroke || !frame?.profile.canReset || frame !== stroke.visible || stroke.held) return false;
      stroke.captured = frame;
      return true;
    },
    replayLayerHeight: async () => {
      const trace = stroke;
      if (!trace?.captured) throw new Error('Missing displayed stroke');
      const { base, captured, samples } = trace;
      const target = { objectId: base.profile.objectId, plateId: base.profile.stamp.plateId };
      const restored = await runtime.readLayerHeight(target);
      if (JSON.stringify(restored.curve) !== JSON.stringify(base.profile.curve)) throw new Error('Replay base differs');
      const strokeId = await runtime.beginLayerHeightStroke({ ...target, stamp: restored.stamp });
      try {
        const replay = await runtime.sampleLayerHeightStroke({ ...target, strokeId, samples });
        return {
          samples, latencyMs: trace.latencyMs, curveValues: replay.profile.curve.length, bytes: replay.pixels.length,
          sameCurve: JSON.stringify(replay.profile.curve) === JSON.stringify(captured.profile.curve),
          sameBands: replay.width === captured.width && replay.height === captured.height && replay.cells === captured.cells &&
            replay.pixels.length === captured.pixels.length && replay.pixels.every((byte, index) => byte === captured.pixels[index]),
        };
      } finally { await runtime.cancelLayerHeightStroke({ ...target, strokeId }); }
    },
  });
  return () => { unregister(); stroke = null; };
}
