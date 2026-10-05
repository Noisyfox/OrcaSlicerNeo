import type { PlateOperationTarget, PlateSessionPlate, PlateSessionSnapshot, PreviewAnalysisSummary } from '@slicer/client';
import type { PlateSliceFailure, PlateSliceResult } from '@/stores/useSlicerStore';

export type PreviewPlateStatus = 'sliced' | 'slicing' | 'error' | 'unsliced' | 'empty' | 'out-of-bounds';

export interface PreviewPlateListItem {
  plate: PlateSessionPlate;
  current: boolean;
  status: PreviewPlateStatus;
  label: string;
  detail: string;
  summary?: PreviewAnalysisSummary;
  error?: string;
  progress?: number;
  progressText?: string;
}

function hasMembers(snapshot: PlateSessionSnapshot, plate: PlateSessionPlate): boolean {
  if (plate.instanceIds) return plate.instanceIds.length > 0;
  if (snapshot.instances) return snapshot.instances.some((instance) => instance.member && instance.plateId === plate.plateId);
  return true;
}

export function projectPreviewPlateList(
  snapshot: PlateSessionSnapshot | null | undefined,
  results: Readonly<Record<string, PlateSliceResult>> = {},
  job: { target: PlateOperationTarget | null; progress: number; text: string } = { target: null, progress: 0, text: '' },
  failures: Readonly<Record<string, PlateSliceFailure>> = {},
): PreviewPlateListItem[] {
  if (!snapshot) return [];
  return snapshot.plates
    .slice()
    .sort((a, b) => a.displayIndex - b.displayIndex)
    .map((plate) => {
      const current = plate.plateId === snapshot.currentPlateId;
      const outOfBounds = plate.valid === false || Boolean(plate.outOfBoundsInstanceIds?.length);
      const empty = !hasMembers(snapshot, plate);
      const revision = snapshot.inputRevisions?.[plate.plateId];
      const result = results[plate.plateId];
      const slicing = job.target?.plateId === plate.plateId && job.target.inputRevision === revision;
      const failure = failures[plate.plateId];
      const error = failure?.target.inputRevision === revision ? failure.error : undefined;
      const sliced = !outOfBounds && !empty && result !== undefined &&
        (revision === undefined || result.target.inputRevision === revision);
      const status: PreviewPlateStatus = outOfBounds
        ? 'out-of-bounds'
        : empty
          ? 'empty'
          : slicing ? 'slicing' : error ? 'error' : sliced ? 'sliced' : 'unsliced';
      const detail = status === 'out-of-bounds'
        ? 'Out of bounds'
        : status === 'empty'
          ? 'Empty'
          : status === 'slicing' ? 'Slicing' : status === 'error' ? 'Error' : status === 'sliced' ? 'Sliced' : 'Not Sliced';
      return { plate, current, status, label: plate.name || `Plate ${plate.displayIndex + 1}`, detail,
        ...(status === 'sliced' ? { summary: result.summary } : {}),
        ...(status === 'slicing' ? { progress: Math.max(0, Math.min(100, job.progress)), progressText: job.text } : {}),
        ...(status === 'error' ? { error } : {}) };
    });
}
