/** Local artifact delivery and print start, distinct from jobs.start(remote file). */
import type { Id, PrinterTarget, TargetRequest, Result, ReadOptions } from './common';
import type { PrintMaterialBinding } from './materials';
import type { MaterialUnit, MaterialSlot } from './materials';
import type { Tool } from './printer';
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
  chamberTemperature: number;
  softeningTemperature: number;
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
/** Includes unavailable paths so the picker can show the physical slot layout. */
export interface PrintMaterialSource {
  materialKey: string;
  pathId: Id<'path'>;
  label: string;
  color: string | null;
  materialType: string | null;
  /** Agent-provided supply-device name and category label, displayed verbatim.
   * `kind` controls grouping/behavior only; the shared UI must not infer vendor names from it. */
  unit: Pick<MaterialUnit, 'id' | 'name' | 'kind'> & { categoryLabel: string };
  slot: Pick<MaterialSlot, 'id' | 'name'>;
  tool: Pick<Tool, 'id' | 'name'>;
  presence: 'present' | 'empty' | 'unknown';
  remainingFraction: number | null;
  /** null means selectable; all vendor eligibility rules stay in the agent. */
  disabledReason: string | null;
}
export interface PrintPreparation {
  /** Display labels in slice tool-index order; vendor physical ordering stays in the agent. */
  nozzleLabels: readonly string[];
  recordingSpace?: { status: 'enough' | 'insufficient' | 'unknown'; canClean: boolean };
  materialCatalogIds: readonly { materialKey: string; catalogId: string }[];
  configurationRevision: string;
  route: 'lan' | 'cloud' | null;
  bindings: readonly PrintMaterialBinding[];
  candidates: readonly PrintMaterialSource[];
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
