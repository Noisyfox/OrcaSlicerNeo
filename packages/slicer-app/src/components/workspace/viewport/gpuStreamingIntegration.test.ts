import { describe, expect, it, vi } from 'vitest';
import type { ClientToolpath } from '@slicer/client';
import {
  DEFAULT_GPU_STREAMING_FEATURE_GATE,
  buildGpuStreamingPlan,
  reportGpuStreamingDiagnostic,
  resolveGpuStreamingFeatureGate,
} from './gpuStreamingIntegration';
import type { GpuStreamingSource } from './gpuStreamingPlanner';

function source(): GpuStreamingSource {
  return {
    segmentCount: 2,
    starts: new Float32Array(6),
    ends: new Float32Array([1, 0, 0, 2, 0, 0]),
    widths: new Float32Array([0.4, 0.4]),
    heights: new Float32Array([0.2, 0.2]),
    layerIds: new Uint32Array([0, 1]),
    moveOrders: new Uint32Array([0, 0]),
    gcodeIds: new Uint32Array([0, 1]),
    moveTypes: new Uint8Array([1, 8]),
    extrusionRoles: new Uint16Array([0, 0]),
    extruderIds: new Uint8Array([0, 0]),
    colorPrintIds: new Uint8Array([0, 0]),
    features: new Uint32Array([1, 1]),
    palette: [{ id: 1, name: 'line', color: [255, 255, 255] }],
    metrics: {},
    layers: [],
  };
}

describe('GPU streaming feature gate', () => {
  it('is closed by default and leaves no implicit renderer selection', () => {
    expect(DEFAULT_GPU_STREAMING_FEATURE_GATE.enabled).toBe(false);
    expect(resolveGpuStreamingFeatureGate().enabled).toBe(false);
  });

  it('keeps the source adapter host-neutral when explicitly enabled', () => {
    const gate = { enabled: true } as const;
    const plan = buildGpuStreamingPlan(source() as unknown as ClientToolpath, undefined, gate);
    expect(plan.diagnostics.sourceSegmentCount).toBe(2);
    expect(plan.pages).toHaveLength(1);
  });

  it('reports non-blocking fallback diagnostics through the injected seam', () => {
    const onDiagnostic = vi.fn();
    reportGpuStreamingDiagnostic({ enabled: true, onDiagnostic }, {
      reason: 'no-context',
      message: 'WebGL2 unavailable',
    });
    expect(onDiagnostic).toHaveBeenCalledWith({ reason: 'no-context', message: 'WebGL2 unavailable' });
  });
});
