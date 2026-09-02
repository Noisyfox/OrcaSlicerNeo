import { describe, expect, it } from 'vitest';
import { HIGH_PERFORMANCE_WEBGL_CONTEXT } from './renderingPreferences';

describe('HIGH_PERFORMANCE_WEBGL_CONTEXT', () => {
  it('provides a preference hint while leaving adapter selection to the browser', () => {
    expect(HIGH_PERFORMANCE_WEBGL_CONTEXT).toEqual({ powerPreference: 'high-performance' });
  });
});
