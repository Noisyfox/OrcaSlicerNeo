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

/** Host-neutral diagnostic emitted when the native renderer is unavailable. */
export interface GpuStreamingDiagnostic {
  readonly reason: string;
  readonly message: string;
}

export interface GpuStreamingBackend {
  readonly status: 'ready' | 'context-lost' | 'disposed';
  attachToScene(scene: import('three').Object3D): void;
  detachFromScene(scene: import('three').Object3D): void;
  updateSelection(selection: GpuStreamingSelection): unknown;
  updateCamera(camera: { readonly position?: import('three').Vector3; readonly viewProjection?: import('three').Matrix4 }): void;
  updateDimming(activeLayer: number, earlierLayerDim?: number): void;
  updatePalette(palette: readonly ToolpathFeature[]): unknown;
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

/** Optional tuning and diagnostic hooks for the sole native renderer. */
export interface GpuStreamingOptions {
  readonly plannerOptions?: GpuStreamingPlannerOptions;
  readonly rendererOptions?: Omit<GpuStreamingRendererOptions, 'renderer' | 'context'>;
  readonly createRenderer?: GpuStreamingRendererFactory;
  readonly onDiagnostic?: (diagnostic: GpuStreamingDiagnostic) => void;
}

export const DEFAULT_GPU_STREAMING_OPTIONS: GpuStreamingOptions = Object.freeze({});

export function reportGpuStreamingDiagnostic(
  options: GpuStreamingOptions,
  diagnostic: GpuStreamingDiagnostic,
): void {
  options.onDiagnostic?.(diagnostic);
  console.warn(`[gpu-streaming] ${diagnostic.reason}: ${diagnostic.message}`);
}

export function buildGpuStreamingPlan(
  toolpath: ClientToolpath,
  metadata: Pick<PreviewMetadata, 'layerRanges'> | undefined,
  options: GpuStreamingOptions = DEFAULT_GPU_STREAMING_OPTIONS,
): GpuStreamingPagePlan {
  return createGpuStreamingPagePlan(toolpath, metadata, options.plannerOptions);
}

export function createGpuStreamingBackend(
  plan: GpuStreamingPagePlan,
  renderer: GpuStreamingRendererHost,
  options: GpuStreamingOptions = DEFAULT_GPU_STREAMING_OPTIONS,
): GpuStreamingBuildResult {
  const factory = options.createRenderer ?? createGpuStreamingRenderer;
  return factory(plan, { ...options.rendererOptions, renderer });
}

export type { GpuStreamingSelection, GpuStreamingSelectionOptions };
