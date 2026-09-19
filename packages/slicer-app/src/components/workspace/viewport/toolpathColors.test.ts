import { describe, expect, it } from 'vitest';
import type { PreviewColorSource } from './toolpathColors';
import {
  colorForPreviewValue,
  describePreviewScheme,
  ORCA_RANGE_COLORS,
  previewSchemeAvailable,
  resolvePreviewColor,
  TRAVEL_MOVE_TYPE,
} from './toolpathColors';

function source(overrides: Partial<PreviewColorSource> = {}): PreviewColorSource {
  return {
    palette: [{ id: 0, name: 'Perimeter', color: [255, 0, 0] }],
    features: Uint32Array.from([0, 0, 0]),
    moveTypes: Uint8Array.from([10, 10, TRAVEL_MOVE_TYPE]),
    extruderIds: Uint8Array.from([0, 1, 0]),
    metrics: {
      feedrate: Float32Array.from([10, 20, 30]),
      volumetricFlow: Float32Array.from([1, 2, 3]),
      layerDuration: Float32Array.from([4, 8, 4]),
      temperature: Float32Array.from([200, 220, 210]),
      fanSpeed: Float32Array.from([0, 50, 100]),
    },
    layerIds: Uint32Array.from([0, 1, 0]),
    extruderPalette: [
      { id: 0, tool: 0, name: 'Red PLA', color: [255, 0, 0] },
      { id: 1, tool: 1, name: 'Blue PLA', color: [0, 0, 255] },
    ],
    analysis: {
      summary: {}, featureStatistics: [], metricRanges: {
        feedrate: { min: 10, max: 30 }, volumetricFlow: { min: 1, max: 3 },
        layerDuration: { min: 4, max: 8 }, temperature: { min: 200, max: 220 }, fanSpeed: { min: 0, max: 100 },
      },
    },
    ...overrides,
  };
}

describe('Phase-C preview color schemes', () => {
  it('uses the native 11-color ramp and active result ranges', () => {
    expect(colorForPreviewValue(0, 0, 10)).toEqual(ORCA_RANGE_COLORS[0]);
    expect(colorForPreviewValue(10, 0, 10)).toEqual(ORCA_RANGE_COLORS[10]);
    expect(colorForPreviewValue(5, 0, 10)).toEqual(expect.arrayContaining([expect.any(Number)]));
  });

  it('keeps travel on the independent Travels color for every scheme', () => {
    const value = resolvePreviewColor(source(), 2, 'temperature');
    expect(value).toEqual([56 / 255, 72 / 255, 155 / 255]);
  });

  it('lifts all-channel near-black categorical colours like OrcaSlicer', () => {
    const black: [number, number, number] = [0, 0, 0];
    const darkFilament = source({ extruderPalette: [
      { id: 0, tool: 0, name: 'Black PLA', color: black },
      { id: 1, tool: 1, name: 'Blue PLA', color: [0, 0, 255] },
    ] });
    expect(resolvePreviewColor(darkFilament, 0, 'filament')).toEqual([0.2, 0.2, 0.2]);
    expect(describePreviewScheme(darkFilament, 'filament')?.items[0]?.color).toEqual([0.2, 0.2, 0.2]);
    expect(resolvePreviewColor(source({ palette: [{ id: 0, name: 'Perimeter', color: black }] }), 0, 'feature'))
      .toEqual([0.2, 0.2, 0.2]);
  });

  it('exposes only schemes backed by the result', () => {
    const noMetrics = source({ metrics: {}, analysis: { summary: {}, featureStatistics: [], metricRanges: {} }, extruderPalette: undefined });
    expect(previewSchemeAvailable(noMetrics, 'feature')).toBe(true);
    expect(previewSchemeAvailable(noMetrics, 'filament')).toBe(false);
    expect(previewSchemeAvailable(noMetrics, 'speed')).toBe(false);
    expect(describePreviewScheme(source(), 'filament')?.items.map((item) => item.label)).toEqual(['Red PLA', 'Blue PLA']);

    const missingTool = source({ extruderPalette: [{ id: 0, tool: 0, name: 'Red PLA', color: [255, 0, 0] }] });
    expect(previewSchemeAvailable(missingTool, 'filament')).toBe(false);
  });
});
