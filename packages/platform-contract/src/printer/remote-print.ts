/** Agent-owned device-file inspection; independent of the current project. */
import type { Id, Result, ReadOptions, Availability } from './common';
import type { RemoteFileRef, FilePreviewOption } from './files';
import type { PrintRequirements, PrintPreparation, PrintPreparationRequest } from './submission';

export interface RemotePrintInspectionRef { file: RemoteFileRef; id: Id<'print-inspection'> }
export interface RemotePrintTarget {
  id: Id<'print-target'>;
  label: string;
  availability: Availability;
  requirements: PrintRequirements | null;
  thumbnail?: FilePreviewOption;
}
export interface RemotePrintInspection {
  ref: RemotePrintInspectionRef;
  targets: readonly RemotePrintTarget[];
  expiresAtMs: number;
}
export interface RemotePrintPreparationRequest extends Omit<PrintPreparationRequest, 'target' | 'requirements'> {
  inspection: RemotePrintInspectionRef;
  targetId: Id<'print-target'>;
}
export interface PrinterRemotePrints {
  inspect(file: RemoteFileRef, options?: ReadOptions): Promise<Result<RemotePrintInspection>>;
  prepare(request: RemotePrintPreparationRequest, options?: ReadOptions): Promise<Result<PrintPreparation>>;
  release(ref: RemotePrintInspectionRef): Promise<Result<null>>;
}
