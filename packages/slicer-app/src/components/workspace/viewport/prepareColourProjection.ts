import type { FilamentSessionSnapshot, ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';
import type { LoadedObject } from './useModelLoader';

export const PREPARE_DEFAULT_COLOUR = '#cbd5e1';
export const PREPARE_DEFAULT_SLOT_COLOURS: Readonly<Record<number, string>> = {};

export interface PrepareMaterialOverlay {
  colour: string;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

/** Compose Prepare's slot colour with renderer overlays. Selection wins over
 * the configured colour, while transparency remains an independent overlay;
 * callers cannot accidentally erase either state while changing a slot. */
export function resolvePrepareMaterial(options: {
  baseColour: string;
  selected?: boolean;
  disabled?: boolean;
  outOfBounds?: boolean;
  transparent?: boolean;
}): PrepareMaterialOverlay {
  const dimmed = options.disabled || options.outOfBounds;
  return {
    colour: options.selected ? '#3b82f6' : dimmed ? shade(options.baseColour, 0.52) : normalizeHex(options.baseColour),
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
