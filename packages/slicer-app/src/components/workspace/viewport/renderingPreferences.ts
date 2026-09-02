import type { WebGLRendererParameters } from 'three';

/**
 * WebGL's standard adapter-selection hint for interactive 3D rendering.
 * It prefers a high-performance adapter when available but does not require
 * one, so browsers can retain their normal integrated-GPU/software fallback.
 */
export const HIGH_PERFORMANCE_WEBGL_CONTEXT: Pick<WebGLRendererParameters, 'powerPreference'> = Object.freeze({
  powerPreference: 'high-performance',
});
