/** Local artifact delivery and print start, distinct from jobs.start(remote file). */
import type { Id, PrinterTarget, TargetRequest, Result, ReadOptions } from './common';
import type { PrintMaterialBinding } from './materials';
import type { PrintOptions } from './print-options';
import type { UploadSource } from './files';

export interface PrintMaterialRequirement {
  key: string;
  index: number;
  type: string;
  color: string;
  presetId: string;
  presetName: string;
  brand: string;
  toolIndex: number;
  nozzleDiameter: number;
  nozzleFlowType: string;
  requiredNozzleHardness: number;
  usedGrams: number;
  usedMeters: number;
}
export interface PrintRequirements {
  /** Opaque identity of one retained slice generation; never a host path. */
  contentId: string;
  plateId: string;
  printerModel: string;
  printerModelId: string;
  materials: readonly PrintMaterialRequirement[];
  nozzleDiameters: readonly number[];
  nozzleFlowTypes: readonly string[];
  filamentMap: readonly number[];
  requiresDynamicMapping: boolean;
  bedType: string;
  durationSeconds: number;
  layerCount: number;
  weightGrams: number;
  timelapseWarningCode: number;
  toolpathOutside: boolean;
  warnings: readonly { message: string; code: string }[];
}
export interface PrintPreparationRequest {
  target: TargetRequest;
  requirements: PrintRequirements;
  bindings: readonly PrintMaterialBinding[];
  options: PrintOptions;
  /** Only initial open/printer change requests suggestions. Refresh never replaces selections. */
  suggest: boolean;
  checkRecording?: boolean;
  allowAbnormalStorage: boolean;
}
export interface PrintIssue {
  id: string;
  severity: 'block' | 'warning' | 'notice';
  message: string;
  materialKey?: string;
}
export interface PrintOptionDescriptor {
  key: keyof PrintOptions;
  label: string;
  choices: readonly { value: string | boolean; label: string }[];
  enabled: boolean;
}
export interface PrintPreparation {
  recordingSpace?: { status: 'enough' | 'insufficient' | 'unknown'; canClean: boolean };
  materialCatalogIds: readonly { materialKey: string; catalogId: string }[];
  configurationRevision: string;
  route: 'lan' | 'cloud' | null;
  bindings: readonly PrintMaterialBinding[];
  candidates: readonly { materialKey: string; pathId: Id<'path'>; label: string; color: string | null; materialType: string | null }[];
  options: PrintOptions;
  optionDescriptors: readonly PrintOptionDescriptor[];
  issues: readonly PrintIssue[];
}
export interface PrintSubmissionRequest extends Omit<PrintPreparationRequest, 'suggest'> {
  requestId: Id<'request'>;
  /** Current submission only; the agent revalidates exact issue identities. */
  acknowledgedIssues: readonly string[];
  recordingSpaceAction?: 'disable-timelapse' | 'clean-oldest';
}
export interface PrintArtifactDescriptor {
  role: 'print' | 'configuration';
  fileName: string;
  sizeBytes: number;
}
export interface PrintArtifactSource extends PrintArtifactDescriptor, UploadSource {}
export interface PrintSubmissionRef extends PrinterTarget { id: Id<'print-submission'> }
export interface PrintSubmissionState {
  ref: PrintSubmissionRef;
  requestId: Id<'request'>;
  phase: 'staging' | 'sending' | 'cancelling' | 'confirming' | 'started' | 'failed' | 'cancelled' | 'unknown';
  route: 'lan' | 'cloud' | null;
  progress: number | null;
  message: string;
  canCancel: boolean;
}
export interface PrinterSubmissions {
  prepare(request: PrintPreparationRequest, options?: ReadOptions): Promise<Result<PrintPreparation>>;
  /** Resolves after admission. Operation owns artifact streams thereafter. */
  submit(request: PrintSubmissionRequest, artifacts: readonly PrintArtifactSource[]): Promise<Result<PrintSubmissionRef>>;
  get(ref: PrintSubmissionRef): Promise<Result<PrintSubmissionState>>;
  cancel(ref: PrintSubmissionRef): Promise<Result<PrintSubmissionState>>;
  watch(ref: PrintSubmissionRef, options?: ReadOptions): AsyncIterable<PrintSubmissionState>;
}
