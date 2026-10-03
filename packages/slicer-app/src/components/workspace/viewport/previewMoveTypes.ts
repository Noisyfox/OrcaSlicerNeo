/** Pinned libslic3r EMoveType values and libvgcode DEFAULT_OPTIONS_COLORS. */
export const TRAVEL_MOVE_TYPE = 8;
export const WIPE_MOVE_TYPE = 9;
export type PreviewMoveVisibility = Readonly<Partial<Record<number, boolean>>>;

export const PREVIEW_MOVE_OPTIONS = [
  { type: 9, label: 'Wipe', color: [255, 255, 0] },
  { type: 1, label: 'Retract', color: [205, 34, 214] },
  { type: 2, label: 'Unretract', color: [73, 173, 207] },
  { type: 3, label: 'Seams', color: [230, 230, 230] },
  { type: 4, label: 'Filament changes', color: [193, 190, 99] },
  { type: 5, label: 'Color changes', color: [218, 148, 139] },
  { type: 6, label: 'Print pauses', color: [82, 240, 131] },
  { type: 7, label: 'Custom G-code', color: [226, 210, 67] },
] as const;

const OPTION_BY_TYPE = new Map<number, (typeof PREVIEW_MOVE_OPTIONS)[number]>(
  PREVIEW_MOVE_OPTIONS.map((option) => [option.type, option]),
);
export function previewMoveOption(type: number) { return OPTION_BY_TYPE.get(type); }
export function isPreviewMarker(type: number): boolean { return type >= 1 && type <= 7; }
export function isIndependentPreviewMove(type: number): boolean {
  return type === TRAVEL_MOVE_TYPE || OPTION_BY_TYPE.has(type);
}
