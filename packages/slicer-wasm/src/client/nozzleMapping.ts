import type { HistoryContext, HistoryStatus } from './history';
import type { PlateSessionMutationResult, NativeScopedConfigTransport } from './types';

/** Native enum values are part of the standard Orca 3MF contract. */
export type NozzleMappingMode = 0 | 1 | 2 | 3;
export interface NozzleMappingValues {
  readonly mode: NozzleMappingMode;
  readonly filamentMap: readonly number[];
  readonly volumeMap: readonly number[];
  readonly nozzleMap: readonly number[];
}
export interface NozzleMappingSnapshot {
  readonly ok: true;
  readonly plateId: string;
  readonly revision: number;
  readonly eligible: boolean;
  readonly nozzles: readonly { readonly id: number; readonly diameter: number; readonly capacity: number }[];
  readonly usedFilaments: readonly number[];
  readonly modes: readonly { readonly mode: NozzleMappingMode; readonly available: boolean; readonly reason: string }[];
  readonly saved: {
    readonly mode: NozzleMappingMode | 4 | null;
    readonly filamentMap: readonly number[] | null;
    readonly volumeMap: readonly number[] | null;
    readonly nozzleMap: readonly number[] | null;
  };
  readonly effective: NozzleMappingValues;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: 'warning' | 'error';
    readonly message: string;
    readonly filament?: number;
    readonly nozzle?: number;
  }[];
}
export type NozzleMappingResult = NozzleMappingSnapshot | {
  readonly ok: false; readonly errorCode: string; readonly error: string;
};
export type NozzleMappingChange =
  | { readonly kind: 'mode'; readonly mode: NozzleMappingMode }
  | { readonly kind: 'mapping'; readonly mode: NozzleMappingMode; readonly filamentMap: readonly number[] }
  | { readonly kind: 'capacity'; readonly nozzle: number; readonly capacity: number };
export interface NozzleMappingRequest {
  readonly plateId: string;
  readonly revision: number;
  readonly plateRevision: number;
  readonly change: NozzleMappingChange;
}
export type NozzleMappingMutationResult = Exclude<NozzleMappingResult, NozzleMappingSnapshot> | {
  readonly ok: true;
  readonly changed: boolean;
  readonly snapshot: NozzleMappingSnapshot;
  readonly historyStatus: HistoryStatus;
  readonly plateSession?: Extract<PlateSessionMutationResult, { ok: true }>;
  readonly nativeScopedConfig?: NativeScopedConfigTransport;
};
export interface NozzleMappingMethods {
  configureNozzleCapacityMemory(memory: Record<string, number[]>, initializeNewProject: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  mutateNozzleMapping(request: NozzleMappingRequest, context: HistoryContext): Promise<NozzleMappingMutationResult>;
  getNozzleMapping(plateId: string): Promise<NozzleMappingResult>;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const vector = (v: unknown): v is number[] => Array.isArray(v) && v.every(integer);
const mode = (v: unknown): v is NozzleMappingMode => integer(v) && v >= 0 && v <= 3;

export function decodeNozzleMapping(value: unknown, plateId: string): NozzleMappingResult {
  const invalid = (): NozzleMappingResult => ({ ok: false, errorCode: 'invalid_projection', error: 'Invalid native nozzle mapping projection' });
  if (!record(value)) return invalid();
  if (value.ok === false && typeof value.errorCode === 'string' && typeof value.error === 'string')
    return { ok: false, errorCode: value.errorCode, error: value.error };
  if (value.ok !== true || value.plateId !== plateId || !integer(value.revision) || value.revision < 0 ||
      typeof value.eligible !== 'boolean' || !Array.isArray(value.nozzles) || !Array.isArray(value.modes) ||
      !record(value.saved) || !record(value.effective) || !Array.isArray(value.diagnostics)) return invalid();
  const { saved, effective } = value;
  if (!mode(effective.mode) || !(saved.mode === null || saved.mode === 4 || mode(saved.mode))) return invalid();
  for (const key of ['filamentMap', 'volumeMap', 'nozzleMap']) {
    if (!vector(effective[key]) || !(saved[key] === null || vector(saved[key]))) return invalid();
  }
  const count = (effective.filamentMap as number[]).length;
  if ((effective.volumeMap as number[]).length !== count || (effective.nozzleMap as number[]).length !== count ||
      !vector(value.usedFilaments) || value.usedFilaments.some((id, i, ids) => id < 1 || id > count || (i > 0 && id <= ids[i - 1]))) return invalid();
  if (value.nozzles.some((n, i) => !record(n) || n.id !== i + 1 || typeof n.diameter !== 'number' ||
      !Number.isFinite(n.diameter) || n.diameter <= 0 || !integer(n.capacity) || n.capacity < 1 || n.capacity > 2147483647)) return invalid();
  if (value.modes.length !== 4 || value.modes.some((m, i) => !record(m) || m.mode !== i ||
      typeof m.available !== 'boolean' || typeof m.reason !== 'string' || (!m.available && !m.reason))) return invalid();
  if (value.diagnostics.some(d => !record(d) || typeof d.code !== 'string' || typeof d.message !== 'string' ||
      (d.severity !== 'warning' && d.severity !== 'error') ||
      (d.filament !== undefined && (!integer(d.filament) || d.filament < 1 || d.filament > count)) ||
      (d.nozzle !== undefined && (!integer(d.nozzle) || d.nozzle < 1 || d.nozzle > (value.nozzles as unknown[]).length)))) return invalid();
  return value as unknown as NozzleMappingSnapshot;
}
