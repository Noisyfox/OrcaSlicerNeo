import type { SlicerRuntime } from '@orca/platform-contract';
import type { SliceStatus } from './stores/useSlicerStore';

/** Serial Print::process() owns the sole Worker, so renderer edits must stop. */
export function isSerialSliceBusy(
  runtime: Partial<Pick<SlicerRuntime, 'getRuntimeExecutionState'>>,
  status: SliceStatus,
): boolean {
  if (status !== 'slicing') return false;
  return runtime.getRuntimeExecutionState?.().threaded !== true;
}
