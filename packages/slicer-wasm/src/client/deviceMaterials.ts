import type { PrinterSynchronizationRequest } from './types';

/** Exact system material-name identity independent of the project, then Orca vendor/type/RGB and type fallback. */
export interface FilamentPresetMatchInput { presetName: string | null; manufacturer: string; materialType: string; colorRgba: string }

/** Read-only catalogue for a physical device, independent of the active project printer. */
export interface DeviceMaterialCatalogueRequest {
  identity: PrinterSynchronizationRequest['identity'];
  mainNozzleDiameterMm: number | null;
  toolIndex: number;
  nozzleFlowType: string | null;
  supportsUserPresets: boolean;
}
export interface DeviceMaterialPreset {
  key: string;
  label: string;
  materialType: string;
  manufacturer: string | null;
  catalogRefs: readonly { namespace: string; value: string }[];
  presetRef: { namespace: string; value: string } | null;
  nozzleTemperatureRangeC: { min: number; max: number } | null;
}
export type DeviceMaterialCatalogue = { ok: true; presets: readonly DeviceMaterialPreset[] }
  | { ok: false; error: string };

export function normalizeDeviceMaterialCatalogue(raw: unknown): DeviceMaterialCatalogue {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const ref = (value: unknown) => object(value) && typeof value.namespace === 'string' && !!value.namespace && typeof value.value === 'string' && !!value.value;
  const preset = (value: unknown) => object(value) && typeof value.key === 'string' && !!value.key && typeof value.label === 'string' && !!value.label
    && typeof value.materialType === 'string' && !!value.materialType && (value.manufacturer === null || typeof value.manufacturer === 'string')
    && Array.isArray(value.catalogRefs) && value.catalogRefs.length > 0 && value.catalogRefs.every(ref) && (value.presetRef === null || ref(value.presetRef))
    && (value.nozzleTemperatureRangeC === null || object(value.nozzleTemperatureRangeC)
      && typeof value.nozzleTemperatureRangeC.min === 'number' && Number.isFinite(value.nozzleTemperatureRangeC.min)
      && typeof value.nozzleTemperatureRangeC.max === 'number' && Number.isFinite(value.nozzleTemperatureRangeC.max)
      && value.nozzleTemperatureRangeC.min > 0 && value.nozzleTemperatureRangeC.max >= value.nozzleTemperatureRangeC.min);
  if (object(raw) && raw.ok === true && Array.isArray(raw.presets) && raw.presets.every(preset)
    && new Set(raw.presets.map(value => value.key)).size === raw.presets.length) return raw as unknown as DeviceMaterialCatalogue;
  return { ok: false, error: object(raw) && raw.ok === false && typeof raw.error === 'string' ? raw.error : 'Invalid device material catalogue response' };
}
