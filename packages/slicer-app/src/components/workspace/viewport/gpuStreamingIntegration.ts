import { createContext, createElement, useContext, type PropsWithChildren } from 'react';
import type { ClientToolpath, PreviewMetadata, ToolpathFeature } from '@slicer/client';
import {
  createGpuStreamingPagePlan,
  type GpuStreamingPagePlan,
  type GpuStreamingPlannerOptions,
  type GpuStreamingSelection,
  type GpuStreamingSelectionOptions,
} from './gpuStreamingPlanner';
import {
  createGpuStreamingRenderer,
  type GpuStreamingRendererHost,
  type GpuStreamingRendererOptions,
  type GpuStreamingUnavailableDiagnostics,
} from './gpuStreamingRenderer';

/** Host-neutral status emitted when the optional backend gives up. */
export interface GpuStreamingDiagnostic {
  readonly reason: string;
  readonly message: string;
}

/** The small seam used by ToolpathLines and by component tests. */
export interface GpuStreamingBackend {
  readonly status: 'ready' | 'context-lost' | 'disposed';
  attachToScene(scene: import('three').Object3D): void;
  detachFromScene(scene: import('three').Object3D): void;
  updateSelection(selection: GpuStreamingSelection): unknown;
  updateCamera(camera: { readonly position?: import('three').Vector3; readonly viewProjection?: import('three').Matrix4 }): void;
  updateDimming(activeLayer: number, earlierLayerDim?: number): void;
  updatePalette(palette: readonly ToolpathFeature[]): unknown;
  /** Releases retired streams only after the completed draw boundary. */
  commitDrawBoundary(): void;
  dispose(): void;
}

export type GpuStreamingBuildResult =
  | { readonly ok: true; readonly backend: GpuStreamingBackend }
  | { readonly ok: false; readonly diagnostics: GpuStreamingUnavailableDiagnostics };

export type GpuStreamingRendererFactory = (
  plan: GpuStreamingPagePlan,
  options: GpuStreamingRendererOptions,
) => GpuStreamingBuildResult;

export interface GpuStreamingFeatureGate {
  /** Streaming is preferred by the production default but remains optional. */
  readonly enabled: boolean;
  readonly plannerOptions?: GpuStreamingPlannerOptions;
  readonly rendererOptions?: Omit<GpuStreamingRendererOptions, 'renderer' | 'context'>;
  readonly createRenderer?: GpuStreamingRendererFactory;
  readonly onDiagnostic?: (diagnostic: GpuStreamingDiagnostic) => void;
}

/**
 * Production prefers the streaming backend.  This is deliberately a
 * preference, not a requirement: ToolpathLines keeps B2 authoritative until
 * capability, budget, construction, context, or selection checks succeed.
 * Callers can still pass `{ enabled: false }` for a host-neutral diagnostic
 * or regression run.
 */
export const DEFAULT_GPU_STREAMING_FEATURE_GATE: GpuStreamingFeatureGate = Object.freeze({ enabled: true });

export const GpuStreamingFeatureGateContext = createContext<GpuStreamingFeatureGate>(DEFAULT_GPU_STREAMING_FEATURE_GATE);

export function GpuStreamingFeatureGateProvider({ gate, children }: PropsWithChildren<{ gate: GpuStreamingFeatureGate }>) {
  return createElement(GpuStreamingFeatureGateContext.Provider, { value: gate }, children);
}

/** Resolve a prop/context gate, with a deliberately test-only browser switch. */
export function resolveGpuStreamingFeatureGate(gate: GpuStreamingFeatureGate = DEFAULT_GPU_STREAMING_FEATURE_GATE): GpuStreamingFeatureGate {
  // This global is only read from Vite's e2e build. Production/dev builds can
  // never be enabled accidentally by a stale browser property.
  const env = import.meta.env as { MODE?: string; VITE_E2E?: string };
  if (env.MODE !== 'e2e' && env.VITE_E2E !== '1') return gate;
  const testWindow = globalThis as typeof globalThis & {
    __orcaE2e?: { gpuStreamingEnabled?: boolean };
  };
  if (!testWindow.__orcaE2e?.gpuStreamingEnabled) return gate;
  return { ...gate, enabled: true };
}

export function useGpuStreamingFeatureGate(): GpuStreamingFeatureGate {
  return useContext(GpuStreamingFeatureGateContext);
}

export function reportGpuStreamingDiagnostic(
  gate: GpuStreamingFeatureGate,
  diagnostic: GpuStreamingDiagnostic,
): void {
  gate.onDiagnostic?.(diagnostic);
  // Fallback is intentionally non-blocking and not a user-facing error.
  console.warn(`[gpu-streaming] ${diagnostic.reason}: ${diagnostic.message}`);
}

export function buildGpuStreamingPlan(
  toolpath: ClientToolpath,
  metadata: Pick<PreviewMetadata, 'layerRanges'> | undefined,
  gate: GpuStreamingFeatureGate,
): GpuStreamingPagePlan {
  return createGpuStreamingPagePlan(toolpath, metadata, gate.plannerOptions);
}

export function createGpuStreamingBackend(
  plan: GpuStreamingPagePlan,
  renderer: GpuStreamingRendererHost,
  gate: GpuStreamingFeatureGate,
): GpuStreamingBuildResult {
  const factory = gate.createRenderer ?? createGpuStreamingRenderer;
  return factory(plan, { ...gate.rendererOptions, renderer });
}

/** Public aliases keep the selection contract easy to use in tests/tools. */
export type { GpuStreamingSelection, GpuStreamingSelectionOptions };
