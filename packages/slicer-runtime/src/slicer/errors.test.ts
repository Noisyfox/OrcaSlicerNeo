// packages/slicer-runtime/src/slicer/errors.test.ts
import { describe, expect, it } from 'vitest';
import { errorText } from './errors';

describe('errorText', () => {
  it('unwraps Error objects (String(err) would add "Error: " — the status bar already prefixes "Error")', () => {
    expect(errorText(new Error('Errors'))).toBe('Errors');
    expect(errorText(new Error('slice failed'))).toBe('slice failed');
  });

  it('passes plain strings through (the bridge error field is already plain text)', () => {
    expect(errorText('no model bytes')).toBe('no model bytes');
  });

  it('stringifies other throwables', () => {
    expect(errorText(42)).toBe('42');
    expect(errorText(undefined)).toBe('undefined');
  });
});
