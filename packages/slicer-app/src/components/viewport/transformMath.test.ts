// apps/desktop/src/renderer/src/components/viewport/transformMath.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseNumberInput,
  formatPosition,
} from './transformMath';

describe('parseNumberInput', () => {
  it('parses finite decimals and rejects garbage', () => {
    expect(parseNumberInput('12.5')).toBe(12.5);
    expect(parseNumberInput('-3')).toBe(-3);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput('1.2.3')).toBeNull();
    expect(parseNumberInput('Infinity')).toBeNull();
  });
});

describe('formatPosition', () => {
  it('formats to 3 decimals', () => {
    expect(formatPosition(12.3456)).toBe('12.346');
    expect(formatPosition(0)).toBe('0.000');
  });
});
