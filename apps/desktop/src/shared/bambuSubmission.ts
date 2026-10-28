import type * as D from '@orca/printer-control/domain';
/** Bounded host transport; no native paths or credentials are renderer-supplied. */
export interface BambuSubmissionInputs {
  'print.prepare': D.PrintPreparationRequest;
  'print.begin': { request: D.PrintSubmissionRequest; artifacts: readonly D.PrintArtifactDescriptor[] };
  'print.chunk': { ref: D.PrintSubmissionRef; role: 'print' | 'configuration'; offset: number; bytes: Uint8Array };
  'print.commit': D.PrintSubmissionRef;
  'print.get': D.PrintSubmissionRef;
  'print.cancel': D.PrintSubmissionRef;
}
export interface BambuSubmissionResults {
  'print.prepare': D.Result<D.PrintPreparation>;
  'print.begin': D.Result<{ ref: D.PrintSubmissionRef; created: boolean }>;
  'print.chunk': D.Result<null>;
  'print.commit': D.Result<D.PrintSubmissionState>;
  'print.get': D.Result<D.PrintSubmissionState>;
  'print.cancel': D.Result<D.PrintSubmissionState>;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string' && v.length <= 2048 && !v.includes('\0');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v);
const target = (v: unknown) => object(v) && string(v.printerId) && string(v.routeId) && (v.expectedConfigurationRevision === undefined || string(v.expectedConfigurationRevision));
const ref = (v: unknown) => target(v) && object(v) && string(v.id) && !!v.id;
function preparation(v: unknown, submit = false): boolean {
  if (!object(v) || !target(v.target) || !object(v.requirements) || !object(v.options) || !Array.isArray(v.bindings) || v.bindings.length > 64 || typeof v.allowAbnormalStorage !== 'boolean') return false;
  if (!v.bindings.every(b => object(b) && string(b.materialKey) && string(b.pathId))) return false;
  if (!Object.entries(v.options).every(([k, x]) => ['bedLeveling', 'flowCalibration', 'nozzleOffsetCalibration'].includes(k) ? ['auto', 'on', 'off'].includes(String(x)) : k === 'timelapseStorage' ? ['internal', 'external'].includes(String(x)) : ['timelapse', 'sharedPressureAdvance', 'externalChangeAssist'].includes(k) && typeof x === 'boolean')) return false;
  if (v.checkRecording !== undefined && typeof v.checkRecording !== 'boolean') return false;
  const r = v.requirements;
  if (!['contentId', 'plateId', 'printerModel', 'printerModelId', 'bedType'].every(k => string(r[k])) || !r.contentId || !Array.isArray(r.materials) || !r.materials.length || r.materials.length > 64) return false;
  if (!r.materials.every(m => object(m) && ['key', 'type', 'color', 'presetId', 'presetName', 'brand', 'nozzleFlowType'].every(k => string(m[k])) && ['index', 'toolIndex'].every(k => integer(m[k])) && Number(m.index) < 64 && Number(m.toolIndex) < 64 && ['nozzleDiameter', 'chamberTemperature', 'softeningTemperature', 'requiredNozzleHardness', 'usedGrams', 'usedMeters'].every(k => finite(m[k])))) return false;
  if (new Set(r.materials.map(m => m.key)).size !== r.materials.length || new Set(r.materials.map(m => m.index)).size !== r.materials.length) return false;
  if (!Array.isArray(r.nozzleDiameters) || !r.nozzleDiameters.length || r.nozzleDiameters.length > 64 || !r.nozzleDiameters.every(finite) || !Array.isArray(r.filamentMap) || r.filamentMap.length > 64 || !r.filamentMap.every(integer)) return false;
  if (!Array.isArray(r.nozzleFlowTypes) || r.nozzleFlowTypes.length !== r.nozzleDiameters.length || !r.nozzleFlowTypes.every(string)) return false;
  const filamentMap = r.filamentMap, nozzleDiameters = r.nozzleDiameters;
  if (!r.materials.every(m => m.index < filamentMap.length && m.toolIndex < nozzleDiameters.length && filamentMap[m.index] === m.toolIndex + 1)) return false;
  if (!['durationSeconds', 'weightGrams', 'layerCount', 'timelapseWarningCode'].every(k => finite(r[k])) || typeof r.requiresDynamicMapping !== 'boolean' || typeof r.toolpathOutside !== 'boolean' || !Array.isArray(r.warnings) || r.warnings.length > 128 || !r.warnings.every(w => object(w) && string(w.message) && string(w.code))) return false;
  return submit ? string(v.jobName) && !!v.jobName.trim() && string(v.requestId) && !!v.requestId && Array.isArray(v.acknowledgedIssues) && v.acknowledgedIssues.length <= 256 && v.acknowledgedIssues.every(string) && (v.recordingSpaceAction === undefined || ['disable-timelapse', 'clean-oldest'].includes(String(v.recordingSpaceAction))) : typeof v.suggest === 'boolean';
}
export function isBambuSubmissionRequest(method: unknown, input: unknown): boolean {
  if (method === 'print.prepare') return preparation(input);
  if (method === 'print.get' || method === 'print.cancel' || method === 'print.commit') return ref(input);
  if (!object(input)) return false;
  if (method === 'print.chunk') return ref(input.ref) && ['print', 'configuration'].includes(String(input.role)) && integer(input.offset) && input.bytes instanceof Uint8Array && input.bytes.byteLength > 0 && input.bytes.byteLength <= 256 * 1024;
  return method === 'print.begin' && preparation(input.request, true) && Array.isArray(input.artifacts) && input.artifacts.length === 2 && new Set(input.artifacts.map(a => object(a) ? a.role : undefined)).size === 2 && input.artifacts.every(a => object(a) && ['print', 'configuration'].includes(String(a.role)) && string(a.fileName) && /^[^/\\]+\.3mf$/i.test(a.fileName) && integer(a.sizeBytes) && a.sizeBytes > 0 && a.sizeBytes <= 512 * 1024 * 1024);
}
