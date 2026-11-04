import { expect, it } from 'vitest';
import { normalizeUserPreferences } from './contracts';

it('preserves the explicit Boolean painting preference and leaves absent/invalid values at the OFF default', () => {
  expect(normalizeUserPreferences({ version: 1, meshBooleanKeepPainting: true }).meshBooleanKeepPainting).toBe(true);
  expect(normalizeUserPreferences({ version: 1, meshBooleanKeepPainting: false }).meshBooleanKeepPainting).toBe(false);
  for (const value of [undefined, null, 'true', 1])
    expect(normalizeUserPreferences({ version: 1, meshBooleanKeepPainting: value }).meshBooleanKeepPainting).toBeUndefined();
});
