import type { MeasureStatus } from '@slicer/client';
import type { SceneInteractionController } from '../../SceneInteractionController';
import type { MeasureController } from './MeasureController';
import { measureDimensions } from './dimensionGeometry';

export interface MeasureScaleRequest {
  readonly sessionId: string;
  readonly targetRevision: number;
  readonly selectionRevision: number;
  /** Unrounded value from the displayed native result. */
  readonly value: number;
}
export type MeasureScaleResult = { outcome: 'committed' | 'unchanged' | 'stale' } | { outcome: 'failed'; error: string };

function matches(status: MeasureStatus | null, request: MeasureScaleRequest): boolean {
  return !!status && status.sameTarget && status.sessionId === request.sessionId && status.targetRevision === request.targetRevision &&
    status.selectionRevision === request.selectionRevision && measureDimensions(status).distance?.value === request.value;
}

/** Uniformly scale the complete scene selection through Neo's normal history
 * boundary, then rebase native features against the committed transforms. */
export async function applyMeasureScale(scene: SceneInteractionController, measure: MeasureController,
  request: MeasureScaleRequest, desired: number, edited: boolean): Promise<MeasureScaleResult> {
  if (!edited || !Number.isFinite(desired) || desired <= 0 || desired === request.value) return { outcome: 'unchanged' };
  if (!(request.value > 0) || !Number.isFinite(desired / request.value)) return { outcome: 'failed', error: 'Invalid scale value' };
  await measure.settled();
  const status = measure.getSnapshot().status;
  if (scene.gizmo !== 'measure' || !matches(status, request)) return { outcome: 'stale' };
  const token = measure.beginScale(status!);
  if (!token) return { outcome: 'failed', error: 'Measure is busy' };
  const ratio = desired / request.value;
  const result = await scene.scaleSelectionByAndWait([ratio, ratio, ratio]);
  const rebased = await measure.finishScale(token, result.outcome === 'committed');
  if (result.outcome === 'committed') return rebased ? { outcome: 'committed' } : { outcome: 'stale' };
  if (result.outcome === 'cancelled') return { outcome: 'unchanged' };
  if (result.outcome === 'stale') return { outcome: 'stale' };
  return { outcome: 'failed', error: result.outcome === 'failed' ? result.error : 'Scale is unavailable' };
}
