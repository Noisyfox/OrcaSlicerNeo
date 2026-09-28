import { describe, expect, it } from 'vitest';
import { cn } from 'cn';

describe('cn', () => {
  it('joins conditional class values from arrays and objects', () => {
    expect(cn('flex', ['gap-2', { 'bg-card': true, hidden: false }])).toBe('flex gap-2 bg-card');
  });

  it('merges conflicting Tailwind classes', () => {
    expect(cn('px-2 text-left', ['px-4', { 'text-right': true }])).toBe('px-4 text-right');
  });
});
