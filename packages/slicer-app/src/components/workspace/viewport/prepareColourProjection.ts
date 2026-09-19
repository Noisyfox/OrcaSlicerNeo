import type { FilamentSessionSnapshot, ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';
import type { LoadedObject } from './useModelLoader';
import { adjustRgbForRendering } from './renderColor';

export const PREPARE_DEFAULT_COLOUR = '#cbd5e1';
export const PREPARE_DEFAULT_SLOT_COLOURS: Readonly<Record<number, string>> = {};

export interface PrepareMaterialOverlay {
  colour: string;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

/** Compose Prepare's slot colour with renderer overlays. Selection brightens
 * the effective slot colour using OrcaSlicer's GLVolume algorithm, while
 * transparency remains an independent overlay; callers cannot accidentally
 * erase either state while changing a slot. */
export function resolvePrepareMaterial(options: {
  baseColour: string;
  selected?: boolean;
  disabled?: boolean;
  outOfBounds?: boolean;
  transparent?: boolean;
}): PrepareMaterialOverlay {
  const dimmed = options.disabled || options.outOfBounds;
  const baseColour = adjustHexForRendering(normalizeHex(options.baseColour));
  return {
    colour: options.selected
      ? brightenForSelection(baseColour)
      : dimmed ? shade(baseColour, 0.52) : baseColour,
    opacity: options.transparent ? 0.15 : 1,
    transparent: Boolean(options.transparent),
    depthWrite: !options.transparent,
  };
}

function normalizeHex(value: string | undefined): string {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : PREPARE_DEFAULT_COLOUR;
}

function shade(hex: string, factor: number): string {
  const value = normalizeHex(hex).slice(1);
  const channels = [0, 2, 4].map((offset) => Math.max(0, Math.min(255, Math.round(Number.parseInt(value.slice(offset, offset + 2), 16) * factor))));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function adjustHexForRendering(hex: string): string {
  const [r, g, b] = adjustRgbForRendering(hexToRgb(hex));
  return rgbToHex(r, g, b);
}

/**
 * Match OrcaSlicer's selection rendering for an opaque CSS hex colour.
 *
 * Native GLVolume converts the already render-adjusted colour to HSL and adds
 * 0.25 to lightness (clamped to 1).
 * The bridge/session owns the actual alpha semantics; Prepare's selection
 * overlay is intentionally RGB-only so Preview transparency stays independent.
 */
function brightenForSelection(hex: string): string {
  let [r, g, b] = hexToRgb(normalizeHex(hex));

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6;
  }

  l = Math.min(l + 0.25, 1);
  if (s === 0) return rgbToHex(l, l, l);

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgbToHex(
    hueToRgb(p, q, h + 1 / 3),
    hueToRgb(p, q, h),
    hueToRgb(p, q, h - 1 / 3),
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function hueToRgb(p: number, q: number, input: number): number {
  let t = input;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function stableVolume(
  volume: LoadedObject,
  structure: readonly ModelObjectStructure[],
) {
  const object = structure.find((entry) => entry.index === volume.buffer.objectIdx);
  const part = object?.volumes[volume.buffer.volumeIdx];
  return { object, part };
}

function instanceIsOutOfBounds(
  volume: LoadedObject,
  plateSession: PlateSessionSnapshot | null | undefined,
): boolean {
  return plateSession?.instances?.some((instance) =>
    instance.objectIndex === volume.buffer.objectIdx &&
    instance.instanceIndex === volume.buffer.instanceIdx &&
    (instance.outOfBounds || instance.unprintable || !instance.member),
  ) ?? false;
}

/**
 * Resolve only the configured Prepare colour for one printable volume. The
 * Worker-projected assignment and slot colour are authoritative; this helper
 * never invents a slot or uses Preview palette data. Selection/opacity are
 * renderer overlays and are applied by ModelMesh after this projection.
 */
export function prepareColourForVolume(
  volume: LoadedObject,
  structure: readonly ModelObjectStructure[],
  snapshot: FilamentSessionSnapshot | null | undefined,
  plateSession?: PlateSessionSnapshot | null,
): string {
  const { object, part } = stableVolume(volume, structure);
  if (!object || !part || part.type !== 'model_part' || !snapshot) return PREPARE_DEFAULT_COLOUR;
  const assignment = snapshot.assignments.parts.find((entry) => entry.id === part.id)
    ?? snapshot.assignments.objects.find((entry) => entry.id === object.id);
  const slot = assignment?.effectiveSlot ?? 0;
  const slotState = snapshot.slots.find((entry) => entry.slot === slot);
  const colour = slotState?.colour.effective ?? PREPARE_DEFAULT_COLOUR;
  if (!object.printable || instanceIsOutOfBounds(volume, plateSession)) return shade(colour, 0.52);
  return normalizeHex(colour);
}
