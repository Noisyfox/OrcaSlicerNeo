// packages/slicer-app/src/components/viewport/ToolpathLines.tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import {
  createToolpathBandMaterial,
  updateToolpathChunkVisibility,
} from './toolpathBandGeometry';
import { buildPreviewVisibility } from './previewSemantics';
import {
  buildGpuStreamingPlan,
  createGpuStreamingBackend,
  reportGpuStreamingDiagnostic,
  resolveGpuStreamingFeatureGate,
  useGpuStreamingFeatureGate,
  type GpuStreamingBackend,
  type GpuStreamingDiagnostic,
  type GpuStreamingFeatureGate,
} from './gpuStreamingIntegration';
import { rebuildGpuStreamingSelection } from './gpuStreamingPlanner';

/**
 * GPU toolpath renderer. Each segment is an instanced rectangular prism whose
 * width/height are world-space attributes. OrbitControls only changes the
 * camera uniforms consumed by the shader; the chunk geometries are created
 * once per slice result and remain resident until that result is invalidated.
 */
export function ToolpathLines({
  data,
  cameraGestureActive = false,
  gpuStreamingGate,
}: {
  data: ToolpathGeometry;
  cameraGestureActive?: boolean;
  /** Optional explicit development/test gate; production defaults to B2. */
  gpuStreamingGate?: GpuStreamingFeatureGate;
}) {
  const preview = useSlicerStore((s) => s.preview);
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const contextGate = useGpuStreamingFeatureGate();
  const gate = useMemo(
    () => resolveGpuStreamingFeatureGate(gpuStreamingGate ?? contextGate),
    [contextGate, gpuStreamingGate],
  );
  const material = useMemo(() => createToolpathBandMaterial(), []);
  const [activeStreaming, setActiveStreaming] = useState<{ plan: ReturnType<typeof buildGpuStreamingPlan>; backend: GpuStreamingBackend } | null>(null);
  const activeStreamingRef = useRef<typeof activeStreaming>(null);
  const initialSelectionBackendRef = useRef<GpuStreamingBackend | null>(null);
  const fallbackDiagnosticRef = useRef<GpuStreamingDiagnostic | null>(
    gate.enabled ? null : {
      reason: 'feature-disabled',
      message: 'GPU streaming is disabled by the shared feature gate; using the B2 preview backend',
    },
  );
  activeStreamingRef.current = activeStreaming;
  const source = data.source;
  const planState = useMemo(() => {
    if (!gate.enabled || !source) return { plan: null, error: null as Error | null };
    try {
      return { plan: buildGpuStreamingPlan(source, data.metadata, gate), error: null as Error | null };
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }, [data.metadata, gate, source]);
  const plan = planState.plan;
  const visibility = useMemo(() => buildPreviewVisibility(data, {
    ...preview,
    // B2 camera gestures only change camera uniforms; keeping this input
    // explicit documents that gestures do not participate in filtering.
    visibleLayerStart: preview.visibleLayerStart,
    visibleLayerEnd: preview.visibleLayerEnd,
  }), [data, preview]);

  const selection = useMemo(() => plan ? rebuildGpuStreamingSelection(plan, {
    visibleLayerStart: preview.visibleLayerStart,
    visibleLayerEnd: preview.visibleLayerEnd,
    activeMoveEnd: preview.activeMoveEnd,
    showTravel: preview.showTravel,
    featureVisibility: preview.featureVisibility,
  }) : null, [plan, preview]);

  // Build the static page plan/atlas only when the immutable source changes.
  // Selection is deliberately absent from this dependency list.
  useLayoutEffect(() => {
    if (!gate.enabled) return;
    if (!source) {
      const diagnostic = { reason: 'source-unavailable', message: 'The B2 preview source did not expose ClientToolpath data' };
      fallbackDiagnosticRef.current = diagnostic;
      reportGpuStreamingDiagnostic(gate, diagnostic);
      return;
    }
    if (planState.error) {
      const diagnostic = { reason: 'planner-failed', message: planState.error.message };
      fallbackDiagnosticRef.current = diagnostic;
      reportGpuStreamingDiagnostic(gate, diagnostic);
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
    const fallback = (reason: string, error?: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : error ? String(error) : reason;
      const diagnostic = { reason, message };
      fallbackDiagnosticRef.current = diagnostic;
      reportGpuStreamingDiagnostic(gate, diagnostic);
      if (backend) {
        try { backend.detachFromScene(scene); } catch { /* best effort before disposal */ }
        backend.dispose();
        backend = null;
      }
      setActiveStreaming(null);
      invalidate();
    };
    try {
      const result = createGpuStreamingBackend(plan, host, gate);
      if (!result.ok) {
        fallback(result.diagnostics.reason, result.diagnostics.message);
        return;
      }
      backend = result.backend as unknown as GpuStreamingBackend;
      if (selection) {
        backend.updateSelection(selection);
        // The first stream is uploaded transactionally with construction;
        // keep the selection effect below from uploading it a second time.
        initialSelectionBackendRef.current = backend;
      }
      if (cancelled) {
        backend.dispose();
        backend = null;
        return;
      }
      backend.attachToScene(scene);
      setActiveStreaming({ plan, backend });
      invalidate();
      const onContextLost = () => fallback('context-lost', 'WebGL context was lost');
      gl.domElement.addEventListener('webglcontextlost', onContextLost);
      return () => {
        cancelled = true;
        gl.domElement.removeEventListener('webglcontextlost', onContextLost);
        if (backend) {
          try { backend.detachFromScene(scene); } catch { /* continue disposal */ }
          backend.dispose();
          backend = null;
        }
        initialSelectionBackendRef.current = null;
        setActiveStreaming((current) => current?.plan === plan ? null : current);
        invalidate();
      };
    } catch (error) {
      fallback('construction-failed', error);
    }
  // `selection` is intentionally read for the initial stream but does not
  // participate in static construction; subsequent changes use the effect
  // below and only call updateSelection().
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate, gl, invalidate, plan, planState.error, scene, source]);

  // Range, move-end, travel, and feature filters replace only index streams.
  useEffect(() => {
    const current = activeStreamingRef.current;
    if (!current || current.plan !== plan || !selection) return;
    if (initialSelectionBackendRef.current === current.backend) {
      initialSelectionBackendRef.current = null;
      return;
    }
    try {
      current.backend.updateSelection(selection);
      invalidate();
    } catch (error) {
      const diagnostic = { reason: 'selection-update-failed', message: error instanceof Error ? error.message : String(error) };
      fallbackDiagnosticRef.current = diagnostic;
      reportGpuStreamingDiagnostic(gate, diagnostic);
      try { current.backend.detachFromScene(scene); } catch { /* best effort */ }
      current.backend.dispose();
      activeStreamingRef.current = null;
      setActiveStreaming(null);
      invalidate();
    }
  }, [gate, invalidate, plan, scene, selection]);

  useEffect(() => {
    const current = activeStreamingRef.current;
    if (!current || current.plan !== plan) return;
    try {
      current.backend.updateDimming(preview.visibleLayerEnd, preview.dimPreviousLayers ? 0.34 : 1);
    } catch (error) {
      reportGpuStreamingDiagnostic(gate, { reason: 'dimming-update-failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, [gate, plan, preview.dimPreviousLayers, preview.visibleLayerEnd]);

  useEffect(() => {
    const current = activeStreamingRef.current;
    if (!current || current.plan !== plan) return;
    // The initial palette is part of static construction. A distinct palette
    // identity is a small replacement upload and never rebuilds the plan.
    if (data.palette === current.plan.source.palette) return;
    try { current.backend.updatePalette(data.palette); } catch (error) {
      reportGpuStreamingDiagnostic(gate, { reason: 'palette-update-failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, [data.palette, gate, plan]);

  useFrame(() => {
    const current = activeStreamingRef.current;
    if (!current || current.plan !== plan) return;
    // Three updates its built-in camera matrices for the draw. The streaming
    // backend receives only the mutable camera uniform; no plan/index upload.
    current.backend.updateCamera({ position: camera.position });
    void cameraGestureActive;
  });

  // Diagnostic-only test seam. It reports which renderer owns the scene and
  // never becomes user-facing UI or an application dependency.
  useEffect(() => {
    const env = import.meta.env as { MODE?: string; VITE_E2E?: string };
    if (env.MODE !== 'e2e' && env.VITE_E2E !== '1') return;
    const testWindow = globalThis as typeof globalThis & {
      __orcaE2e?: {
        gpuStreamingStatus?: () => 'ready' | 'context-lost' | 'disposed' | 'b2';
        gpuStreamingDiagnostic?: () => GpuStreamingDiagnostic | null;
      };
    };
    testWindow.__orcaE2e = {
      ...testWindow.__orcaE2e,
      gpuStreamingStatus: () => activeStreamingRef.current?.backend.status ?? 'b2',
      gpuStreamingDiagnostic: () => fallbackDiagnosticRef.current,
    };
    return () => {
      if (!testWindow.__orcaE2e) return;
      const { gpuStreamingStatus: _status, gpuStreamingDiagnostic: _diagnostic, ...rest } = testWindow.__orcaE2e;
      testWindow.__orcaE2e = rest;
    };
  }, []);

  useEffect(() => {
    // Keep every instance in the draw call. The visibility attribute is a
    // prebuilt GPU buffer, so range/filter changes do not rebuild geometry.
    if (!activeStreaming || activeStreaming.plan !== plan) updateToolpathChunkVisibility(data.chunks, visibility);
    invalidate();
  }, [activeStreaming, data.chunks, invalidate, plan, visibility]);

  useEffect(() => () => material.dispose(), [material]);

  const useStreaming = activeStreaming?.plan === plan;
  return (
    <group renderOrder={1000}>
      {!useStreaming && data.chunks.map((chunk) => (
        <mesh
          key={`${chunk.firstSegment}:${chunk.segmentCount}`}
          geometry={chunk.geometry}
          material={material}
          frustumCulled={false}
          renderOrder={1000}
        />
      ))}
    </group>
  );
}
