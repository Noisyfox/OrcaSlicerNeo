import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import {
  buildGpuStreamingPlan,
  createGpuStreamingBackend,
  DEFAULT_GPU_STREAMING_OPTIONS,
  reportGpuStreamingDiagnostic,
  type GpuStreamingBackend,
  type GpuStreamingDiagnostic,
} from './gpuStreamingIntegration';
import { rebuildGpuStreamingSelection } from './gpuStreamingPlanner';

/**
 * Native Orca/libvgcode-style SegmentTemplate renderer.
 *
 * A capability, allocation, shader, or context failure leaves the preview
 * unavailable and reports a diagnostic. There is deliberately no CPU/entity
 * renderer here: having two path implementations made large previews select
 * different geometry and hid renderer failures behind a visually incomplete
 * result.
 */
export function ToolpathLines({ data, cameraGestureActive = false }: { data: ToolpathGeometry; cameraGestureActive?: boolean }) {
  const preview = useSlicerStore((s) => s.preview);
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const [active, setActive] = useState<{
    plan: ReturnType<typeof buildGpuStreamingPlan>;
    backend: GpuStreamingBackend;
  } | null>(null);
  const activeRef = useRef<typeof active>(null);
  const diagnosticRef = useRef<GpuStreamingDiagnostic | null>(null);
  activeRef.current = active;

  const source = data.source;
  const planState = useMemo(() => {
    if (!source) {
      return {
        plan: null,
        error: new Error('The slice result did not expose ClientToolpath data'),
      };
    }
    try {
      return {
        plan: buildGpuStreamingPlan(source, data.metadata, DEFAULT_GPU_STREAMING_OPTIONS),
        error: null as Error | null,
      };
    } catch (error) {
      return {
        plan: null,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }, [data.metadata, source]);
  const plan = planState.plan;

  const selection = useMemo(() => plan ? rebuildGpuStreamingSelection(plan, {
    visibleLayerStart: preview.visibleLayerStart,
    visibleLayerEnd: preview.visibleLayerEnd,
    activeMoveEnd: preview.activeMoveEnd,
    showTravel: preview.showTravel,
    featureVisibility: preview.featureVisibility,
  }) : null, [plan, preview]);

  useLayoutEffect(() => {
    if (!source) {
      const diagnostic = {
        reason: 'source-unavailable',
        message: 'The slice result did not expose ClientToolpath data',
      };
      diagnosticRef.current = diagnostic;
      reportGpuStreamingDiagnostic(DEFAULT_GPU_STREAMING_OPTIONS, diagnostic);
      setActive(null);
      return;
    }
    if (planState.error) {
      const diagnostic = {
        reason: 'planner-failed',
        message: planState.error.message,
      };
      diagnosticRef.current = diagnostic;
      reportGpuStreamingDiagnostic(DEFAULT_GPU_STREAMING_OPTIONS, diagnostic);
      setActive(null);
      return;
    }
    if (!plan) return;

    let cancelled = false;
    let backend: GpuStreamingBackend | null = null;
    const host = {
      getContext: () => gl.getContext() as WebGLRenderingContext,
      domElement: gl.domElement,
      compile: (nextScene: THREE.Scene, nextCamera: THREE.Camera) => gl.compile(nextScene, nextCamera),
    };
    const unavailable = (reason: string, error?: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : error ? String(error) : reason;
      const diagnostic = { reason, message };
      diagnosticRef.current = diagnostic;
      reportGpuStreamingDiagnostic(DEFAULT_GPU_STREAMING_OPTIONS, diagnostic);
      if (backend) {
        try { backend.detachFromScene(scene); } catch { /* best effort */ }
        backend.dispose();
        backend = null;
      }
      setActive(null);
      invalidate();
    };

    try {
      const result = createGpuStreamingBackend(plan, host, DEFAULT_GPU_STREAMING_OPTIONS);
      if (!result.ok) {
        unavailable(result.diagnostics.reason, result.diagnostics.message);
        return;
      }
      backend = result.backend;
      if (selection) backend.updateSelection(selection);
      if (cancelled) {
        backend.dispose();
        backend = null;
        return;
      }
      backend.attachToScene(scene);
      setActive({ plan, backend });
      invalidate();
      const onContextLost = () => unavailable('context-lost', 'WebGL context was lost');
      gl.domElement.addEventListener('webglcontextlost', onContextLost);
      return () => {
        cancelled = true;
        gl.domElement.removeEventListener('webglcontextlost', onContextLost);
        if (backend) {
          try { backend.detachFromScene(scene); } catch { /* best effort */ }
          backend.dispose();
          backend = null;
        }
        setActive((current) => current?.plan === plan ? null : current);
        invalidate();
      };
    } catch (error) {
      unavailable('construction-failed', error);
    }
  // Selection is intentionally read only for the first upload. Subsequent
  // slider/filter changes use the index-only effect below and must not rebuild
  // the native static textures or page meshes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, invalidate, plan, planState.error, scene, source]);

  useEffect(() => {
    const current = activeRef.current;
    if (!current || current.plan !== plan || !selection) return;
    try {
      current.backend.updateSelection(selection);
      invalidate();
    } catch (error) {
      const diagnostic = {
        reason: 'selection-update-failed',
        message: error instanceof Error ? error.message : String(error),
      };
      diagnosticRef.current = diagnostic;
      reportGpuStreamingDiagnostic(DEFAULT_GPU_STREAMING_OPTIONS, diagnostic);
      try { current.backend.detachFromScene(scene); } catch { /* best effort */ }
      current.backend.dispose();
      activeRef.current = null;
      setActive(null);
      invalidate();
    }
  }, [invalidate, plan, scene, selection]);

  useEffect(() => {
    const current = activeRef.current;
    if (!current || current.plan !== plan) return;
    try {
      current.backend.updateDimming(preview.visibleLayerEnd, preview.dimPreviousLayers ? 0.34 : 1);
    } catch (error) {
      reportGpuStreamingDiagnostic(DEFAULT_GPU_STREAMING_OPTIONS, {
        reason: 'dimming-update-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [plan, preview.dimPreviousLayers, preview.visibleLayerEnd]);

  useEffect(() => {
    const current = activeRef.current;
    if (!current || current.plan !== plan || data.palette === current.plan.source.palette) return;
    try {
      current.backend.updatePalette(data.palette);
    } catch (error) {
      reportGpuStreamingDiagnostic(DEFAULT_GPU_STREAMING_OPTIONS, {
        reason: 'palette-update-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [data.palette, plan]);

  useFrame(() => {
    const current = activeRef.current;
    if (current?.plan === plan) current.backend.updateCamera({ position: camera.position });
    void cameraGestureActive;
  });

  // Diagnostic-only test seam; it never selects another renderer.
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1') return;
    const testWindow = globalThis as typeof globalThis & {
      __orcaE2e?: {
        gpuStreamingStatus?: () => 'ready' | 'context-lost' | 'disposed' | 'unavailable';
        gpuStreamingDiagnostic?: () => GpuStreamingDiagnostic | null;
      };
    };
    testWindow.__orcaE2e = {
      ...testWindow.__orcaE2e,
      gpuStreamingStatus: () => activeRef.current?.backend.status ?? 'unavailable',
      gpuStreamingDiagnostic: () => diagnosticRef.current,
    };
    return () => {
      if (!testWindow.__orcaE2e) return;
      const { gpuStreamingStatus: _status, gpuStreamingDiagnostic: _diagnostic, ...rest } = testWindow.__orcaE2e;
      testWindow.__orcaE2e = rest;
    };
  }, []);

  return <group renderOrder={1000} />;
}
