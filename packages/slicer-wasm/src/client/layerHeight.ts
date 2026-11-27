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
export type LayerHeightAction =
  | { operation: 'adaptive'; quality: number }
  | { operation: 'smooth'; radius: number; keepMin: boolean }
  | { operation: 'reset' };
export type LayerHeightEditResult = ModelMutationResult<{ changed: true }> |
  { ok: true; changed: false; plateSession?: never; error?: never };
export interface LayerHeightApi {
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
