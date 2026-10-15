import { expect, it } from 'vitest';
import { colorValueSupported, normalizeColorFavorites, normalizeColorValue, normalizeHexColor } from './colorPicker';
import { normalizeUserPreferences } from './contracts';

it('normalizes opaque equivalence, shorthand, transparency and malformed input', () => {
  expect(normalizeHexColor(' #aBcF ')).toBe('#AABBCC');
  expect(normalizeHexColor('#1234')).toBe('#11223344');
  expect(normalizeHexColor('#12345600')).toBe('#12345600');
  expect(normalizeHexColor('garbage')).toBeNull();
  expect(normalizeColorValue({ kind: 'linear-gradient', colors: ['#fff', 'invalid'] })).toBeNull();
});
it('deduplicates canonical values, filters invalid entries and bounds favorites', () => {
  const first = { kind: 'solid', color: '#112233' };
  const rest = Array.from({ length: 30 }, (_, i) => ({ kind: 'solid', color: '#' + i.toString(16).padStart(6, '0') }));
  const result = normalizeColorFavorites([null, first, { ...first, color: '#112233FF' }, ...rest]);
  expect(result).toHaveLength(24);
  expect(result[0]).toEqual(first);
  expect(normalizeColorFavorites({})).toEqual([]);
});
it('filters capabilities without mutating stored values', () => {
  const transparent = { kind: 'solid', color: '#11223380' } as const;
  const gradient = { kind: 'linear-gradient', colors: ['#000', '#fff'] } as const;
  expect(colorValueSupported(transparent)).toBe(false);
  expect(colorValueSupported(transparent, true)).toBe(true);
  expect(colorValueSupported(gradient, true)).toBe(false);
  expect(colorValueSupported(gradient, false, true)).toBe(true);
});

it('keeps old preference documents compatible and filters corrupt favorites independently', () => {
  expect(normalizeUserPreferences({ version: 1 })).not.toHaveProperty('colorPicker');
  expect(normalizeUserPreferences({ version: 1, colorPicker: { favorites: [null,
    { kind: 'solid', color: '#abcd' }, { kind: 'solid', color: '#AABBCCDD' },
    { kind: 'linear-gradient', colors: ['#112233', 'bad!'] }], ignored: true } }).colorPicker)
    .toEqual({ favorites: [{ kind: 'solid', color: '#AABBCCDD' }] });
});

it('rejects malformed gradient cardinality and preserves all seven ordered alpha colors in preferences', () => {
  const colors = ['#FF000001', '#FFFF0080', '#00FF00FE', '#00FFFF00', '#0000FF', '#FF00FF40', '#FF8000AA'];
  for (const value of [null, '#112233', [], ['#112233'], Array(8).fill('#112233'), ['#112233', 'bad!']]) {
    expect(normalizeColorValue({ kind: 'linear-gradient', colors: value })).toBeNull();
  }
  const favorite = { kind: 'linear-gradient', colors };
  expect(normalizeUserPreferences({ version: 1, colorPicker: { favorites: [favorite],
    ui: { sidebarOpen: true, paletteId: 'gradient' } } }).colorPicker)
    .toEqual({ favorites: [favorite], ui: { sidebarOpen: true, paletteId: 'gradient' } });
  expect(normalizeUserPreferences({ version: 1, colorPicker: { favorites: [favorite],
    ui: { sidebarOpen: 'true', paletteId: [] } } }).colorPicker!.ui)
    .toEqual({ sidebarOpen: false, paletteId: 'basic' });
});
