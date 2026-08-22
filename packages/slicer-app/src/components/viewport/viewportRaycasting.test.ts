import { describe, expect, it } from 'vitest';
import { isViewportRaycastingEnabled } from './viewportRaycasting';

describe('isViewportRaycastingEnabled', () => {
  it('allows idle hover picking', () => {
    expect(isViewportRaycastingEnabled(false, 'none')).toBe(true);
  });

  it.each(['body', 'gizmo', 'box'] as const)('disables picking while a %s drag owns the pointer', (owner) => {
    expect(isViewportRaycastingEnabled(false, owner)).toBe(false);
  });

  it('disables picking for an active camera gesture before it reaches a model', () => {
    expect(isViewportRaycastingEnabled(true, 'none')).toBe(false);
  });
});
