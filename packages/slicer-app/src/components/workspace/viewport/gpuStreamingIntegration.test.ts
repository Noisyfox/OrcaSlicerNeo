import { describe, expect, it, vi } from 'vitest';
import type { ClientToolpath } from '@slicer/client';
import {
  DEFAULT_GPU_STREAMING_OPTIONS,
  buildGpuStreamingPlan,
  createGpuStreamingBackend,
  reportGpuStreamingDiagnostic,
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

describe('native GPU streaming integration', () => {
  it('uses the native renderer options as the production default', () => {
    expect(DEFAULT_GPU_STREAMING_OPTIONS).toEqual({});
  });

  it('keeps the source adapter host-neutral', () => {
    const plan = buildGpuStreamingPlan(source() as unknown as ClientToolpath, undefined);
    expect(plan.diagnostics.sourceSegmentCount).toBe(2);
    expect(plan.pages).toHaveLength(1);
  });

  it('constructs the native backend when no renderer override is supplied', () => {
    const plan = buildGpuStreamingPlan(source() as unknown as ClientToolpath, undefined);
    const context = {
      VERSION: 'VERSION',
      MAX_TEXTURE_SIZE: 'MAX_TEXTURE_SIZE',
      MAX_TEXTURE_IMAGE_UNITS: 'MAX_TEXTURE_IMAGE_UNITS',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
      getParameter: (key: string) => ({
        VERSION: 'WebGL 2.0 mock',
        MAX_TEXTURE_SIZE: 4096,
        MAX_TEXTURE_IMAGE_UNITS: 8,
        MAX_VERTEX_TEXTURE_IMAGE_UNITS: 8,
      }[key]),
    } as unknown as WebGLRenderingContext;
    const result = createGpuStreamingBackend(plan, { getContext: () => context });
    expect(result.ok).toBe(true);
    if (result.ok) result.backend.dispose();
  });

  it('reports non-blocking fallback diagnostics through the injected seam', () => {
    const onDiagnostic = vi.fn();
    reportGpuStreamingDiagnostic({ onDiagnostic }, {
      reason: 'no-context',
      message: 'WebGL2 unavailable',
    });
    expect(onDiagnostic).toHaveBeenCalledWith({ reason: 'no-context', message: 'WebGL2 unavailable' });
  });
});
