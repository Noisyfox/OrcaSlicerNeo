import { describe, expect, it } from 'vitest';
import { compatibilityFallback, projectNameFromDisplayName, shouldAskProjectLoad } from './projectSession';

describe('project session policy', () => {
  it.each([
    ['load_all', false, false], ['load_all', true, false],
    ['ask_when_relevant', false, false], ['ask_when_relevant', true, true],
    ['always_ask', false, true], ['always_ask', true, true],
    ['load_geometry_only', false, false], ['load_geometry_only', true, false],
  ] as const)('load policy %s with model=%s asks=%s', (policy, model, expected) => {
    expect(shouldAskProjectLoad(policy, model)).toBe(expected);
  });

  it('reports generic, unsupported, and missing-setting fallback reasons', () => {
    expect(compatibilityFallback({ ok: true, objects: 1, instances: 1, compatibility: 'generic' })).toContain('generic');
    expect(compatibilityFallback({ ok: true, objects: 1, instances: 1, compatibility: 'unsupported' })).toContain('unavailable');
    expect(compatibilityFallback({ ok: true, objects: 1, instances: 1, compatibility: 'orca', projectSettingsAvailable: false })).toContain('unavailable');
    expect(compatibilityFallback({ ok: true, objects: 1, instances: 1, compatibility: 'bambu', projectSettingsAvailable: true })).toBeNull();
  });

  it('derives a safe project name from a display name', () => {
    expect(projectNameFromDisplayName('C:\\work\\Robot.3MF')).toBe('Robot');
    expect(projectNameFromDisplayName('')).toBe('Untitled');
  });
});

