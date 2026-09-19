/** OrcaSlicer's `adjust_color_for_rendering` near-black threshold. */
export const MIN_RENDER_COLOR_CHANNEL = 0.2;

/**
 * Keep opaque near-black model and categorical preview colours visible under
 * 3D lighting, matching native OrcaSlicer's render-colour preprocessing.
 */
export function adjustRgbForRendering(color: readonly [number, number, number]): [number, number, number] {
  return color[0] < MIN_RENDER_COLOR_CHANNEL && color[1] < MIN_RENDER_COLOR_CHANNEL && color[2] < MIN_RENDER_COLOR_CHANNEL
    ? [MIN_RENDER_COLOR_CHANNEL, MIN_RENDER_COLOR_CHANNEL, MIN_RENDER_COLOR_CHANNEL]
    : [color[0], color[1], color[2]];
}
