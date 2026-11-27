import { callJson, readBytes } from './heap';
import type { OrcaModule } from './types';
import type { ModelMutationResult } from './types';

export interface LayerHeightTarget { objectId: number; plateId: string }
export interface LayerHeightStamp {
  plateId: string;
  inputRevision: number;
  profileRevision: number;
  historyRevision: number;
}
export interface LayerHeightProfile {
  objectId: number;
  stamp: LayerHeightStamp;
  /** Interleaved object Z and layer height in millimetres. */
  curve: number[];
  objectHeight: number;
  baseHeight: number;
  minHeight: number;
  maxHeight: number;
  firstHeight: number;
  canReset: boolean;
  hasSavedCurve: boolean;
}
export interface LayerHeightFrame {
  profile: LayerHeightProfile;
  width: number;
  height: number;
  cells: number;
  pixels: Uint8Array;
}
export type LayerHeightSample = { z: number; width: number; action: 0 | 1 | 2 | 3 };
export type LayerHeightStroke = LayerHeightTarget & { strokeId: number };
export type LayerHeightAction =
  | { operation: 'adaptive'; quality: number }
  | { operation: 'smooth'; radius: number; keepMin: boolean }
  | { operation: 'reset' };
export type LayerHeightEditResult = ModelMutationResult<{ changed: true }> |
  { ok: true; changed: false; plateSession?: never; error?: never };
export interface LayerHeightApi {
  previewLayerHeight(target: LayerHeightTarget): Promise<LayerHeightFrame>;
  beginLayerHeightStroke(target: LayerHeightTarget & { stamp: LayerHeightStamp }): Promise<number>;
  sampleLayerHeightStroke(stroke: LayerHeightStroke & { samples: LayerHeightSample[] }): Promise<LayerHeightFrame>;
  cancelLayerHeightStroke(stroke: LayerHeightStroke): Promise<void>;
  finishLayerHeightStroke(stroke: LayerHeightStroke): Promise<LayerHeightEditResult>;
  readLayerHeight(target: LayerHeightTarget): Promise<LayerHeightProfile>;
  editLayerHeight(command: LayerHeightTarget & { stamp: LayerHeightStamp } & LayerHeightAction): Promise<LayerHeightEditResult>;
}

export function isLayerHeightProfile(raw: unknown, target: LayerHeightTarget): raw is LayerHeightProfile {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Partial<LayerHeightProfile>;
  return p.objectId === target.objectId && p.stamp?.plateId === target.plateId &&
    [p.stamp.inputRevision, p.stamp.profileRevision, p.stamp.historyRevision].every(Number.isSafeInteger) &&
    Array.isArray(p.curve) && p.curve.length >= 4 && p.curve.length % 2 === 0 && p.curve.every(Number.isFinite) &&
    [p.objectHeight, p.baseHeight, p.minHeight, p.maxHeight, p.firstHeight].every(v => typeof v === 'number' && v > 0 && Number.isFinite(v)) &&
    typeof p.canReset === 'boolean' && typeof p.hasSavedCurve === 'boolean';
}

export function layerHeightRequest(module: OrcaModule, target: LayerHeightTarget, operation: string) {
  const raw = callJson(module, 'orc_layer_height', ['string'], [JSON.stringify({ ...target, operation })]);
  if (!raw || typeof raw !== 'object' || !('ok' in raw) || raw.ok !== true)
    throw new Error(raw && typeof raw === 'object' && 'error' in raw ? String(raw.error) : 'Invalid layer height response');
  return raw as Record<string, unknown>;
}

export function layerHeightFrame(module: OrcaModule, target: LayerHeightTarget, operation: 'samples' | 'preview'): LayerHeightFrame {
  const raw = layerHeightRequest(module, target, operation);
  const { width, height, cells, pointer } = raw;
  if (typeof pointer !== 'number' || !Number.isSafeInteger(pointer) || pointer <= 0 || pointer >= module.HEAPU8.length)
    throw new Error('Invalid layer texture allocation');
  if (!isLayerHeightProfile(raw.profile, target) || typeof width !== 'number' || typeof height !== 'number' ||
      typeof cells !== 'number' || ![width, height, cells].every(Number.isSafeInteger) ||
      width < 2 || height < 1 || cells < 1 || cells > (width - 1) * height || width * height * 4 > module.HEAPU8.length - pointer) {
    module._free(pointer);
    throw new Error('Invalid layer height frame');
  }
  return { profile: raw.profile, width, height, cells, pixels: readBytes(module, pointer, width * height * 4) };
}
