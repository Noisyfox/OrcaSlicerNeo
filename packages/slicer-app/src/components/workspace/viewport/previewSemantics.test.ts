// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { buildPreviewVisibility, createPreviewInspectionIndex, createPreviewSourceLineIndex, findPreviewMove, findPreviewMoveForSourceLine, isPreviewInspectionKey, lastMovePosition, maxMoveOrderForLayer, previewKeyboardStep, previewViewportOwnsKeyboardFocus, sourceLineForPreviewMove, TRAVEL_MOVE_TYPE } from './previewSemantics';
import type { ToolpathGeometry } from './useSliceResult';

const data = {
  segmentCount: 6,
  layerIds: Uint32Array.from([0, 0, 1, 1, 1, 2]),
  moveOrders: Uint32Array.from([0, 1, 0, 1, 2, 0]),
  gcodeIds: Uint32Array.from([4, 7, 10, 11, 15, 20]),
  moveTypes: Uint8Array.from([10, TRAVEL_MOVE_TYPE, 10, 10, TRAVEL_MOVE_TYPE, 10]),
  features: Uint32Array.from([0, 1, 0, 1, 0, 1]),
  extruderIds: new Uint8Array(6),
  ends: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0]),
  metadata: {
    resultId: 1,
    layerRanges: [
      { id: 0, z: 0.2, firstSegment: 0, segmentCount: 2 },
      { id: 1, z: 0.4, firstSegment: 2, segmentCount: 3 },
      { id: 2, z: 0.6, firstSegment: 5, segmentCount: 1 },
    ],
    featurePalette: [],
    sourceLineMapping: { available: true, lineCount: 20 },
  },
} satisfies Pick<ToolpathGeometry, 'segmentCount' | 'layerIds' | 'moveOrders' | 'gcodeIds' | 'moveTypes' | 'features' | 'extruderIds' | 'ends' | 'metadata'>;

describe('preview inspection semantics', () => {
  it('shows the active layer from its start through the inclusive move end', () => {
    expect(buildPreviewVisibility(data, {
      visibleLayerStart: 0, visibleLayerEnd: 1,
      activeMoveEnd: 1,
      showTravel: true, dimPreviousLayers: true,
    })).toMatchObject({ visible: Uint8Array.from([1, 1, 1, 1, 0, 0]), dimmed: Uint8Array.from([1, 1, 0, 0, 0, 0]) });
  });

  it('hides travel and disabled features instead of dimming them', () => {
    const result = buildPreviewVisibility(data, {
      visibleLayerStart: 0, visibleLayerEnd: 2,
      activeMoveEnd: 10,
      showTravel: false, dimPreviousLayers: false,
      visibility: { 1: false },
    });
    expect(Array.from(result.visible)).toEqual([1, 0, 1, 0, 0, 0]);
  });

  it('keeps travel visible when its stale extrusion feature is hidden', () => {
    const result = buildPreviewVisibility(data, {
      visibleLayerStart: 0, visibleLayerEnd: 0,
      activeMoveEnd: 10, showTravel: true, dimPreviousLayers: false,
      visibility: { 1: false },
    });
    expect(Array.from(result.visible)).toEqual([1, 1, 0, 0, 0, 0]);
  });

  it('finds the last move at or before the active end', () => {
    expect(maxMoveOrderForLayer(data, 1)).toBe(2);
    expect(lastMovePosition(data, 1, 1)).toEqual([3, 0, 0]);
    expect(lastMovePosition(data, 8, 0)).toBeNull();
  });

  it('puts the marker at the final segment of one logical arc move', () => {
    const arc = {
      segmentCount: 4,
      layerIds: Uint32Array.from([0, 0, 0, 0]),
      // The first three rendered segments are one G2/G3 source command;
      // the fourth is the following command.
      moveOrders: Uint32Array.from([0, 0, 0, 1]),
      ends: Float32Array.from([
        1, 0, 0,
        2, 0, 0,
        3, 0, 0,
        4, 0, 0,
      ]),
      metadata: {
        resultId: 2,
        layerRanges: [{ id: 0, z: 0.2, firstSegment: 0, segmentCount: 4 }],
        featurePalette: [],
      },
    };
    expect(lastMovePosition(arc, 0, 0)).toEqual([3, 0, 0]);
    expect(lastMovePosition(arc, 0, 1)).toEqual([4, 0, 0]);
  });

  it('only claims keyboard shortcuts for the focused viewport', () => {
    const viewport = document.createElement('div');
    const canvas = document.createElement('canvas'); viewport.append(canvas);
    const button = document.createElement('button'); viewport.append(button);
    expect(previewViewportOwnsKeyboardFocus(canvas, viewport, viewport)).toBe(true);
    expect(previewViewportOwnsKeyboardFocus(button, viewport, viewport)).toBe(false);
    expect(previewViewportOwnsKeyboardFocus(canvas, viewport, button)).toBe(false);
    const input = document.createElement('input'); viewport.append(input);
    expect(previewViewportOwnsKeyboardFocus(input, viewport, viewport)).toBe(false);
    expect(previewViewportOwnsKeyboardFocus(canvas, viewport, viewport)).toBe(true);
    expect(previewViewportOwnsKeyboardFocus(document.body, viewport, document.body)).toBe(false);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    if (previewViewportOwnsKeyboardFocus(canvas, viewport, viewport) && isPreviewInspectionKey(tab.key)) tab.preventDefault();
    expect(tab.defaultPrevented).toBe(false);
  });

  it('accelerates inspection arrows with Shift or Ctrl, but not Tab', () => {
    expect(previewKeyboardStep({ shiftKey: false, ctrlKey: false, metaKey: false })).toBe(1);
    expect(previewKeyboardStep({ shiftKey: true, ctrlKey: false, metaKey: false })).toBe(5);
    expect(previewKeyboardStep({ shiftKey: false, ctrlKey: true, metaKey: false })).toBe(5);
    expect(isPreviewInspectionKey('Tab')).toBe(false);
    expect(isPreviewInspectionKey('ArrowUp')).toBe(true);
    expect(isPreviewInspectionKey('c')).toBe(true);
  });

  it('keeps the marker moving after a large-move layer changes to a smaller one', () => {
    useSlicerStore.getState().setPreviewBounds(2, 10, 44);
    useSlicerStore.getState().setPreviewMoveEnd(10);
    const before = lastMovePosition(data, 2, useSlicerStore.getState().preview.activeMoveEnd);
    useSlicerStore.getState().setPreviewLayerEnd(1, maxMoveOrderForLayer(data, 1));
    const afterLayerChange = lastMovePosition(data, 1, useSlicerStore.getState().preview.activeMoveEnd);
    expect(useSlicerStore.getState().preview).toMatchObject({ maxMove: 2, activeMoveEnd: 2 });
    expect(afterLayerChange).not.toEqual(before);
    useSlicerStore.getState().setPreviewMoveEnd(1);
    expect(lastMovePosition(data, 1, useSlicerStore.getState().preview.activeMoveEnd)).toEqual([3, 0, 0]);
    useSlicerStore.getState().resetPreviewState();
  });

  it('resolves the nearest available move without rescanning on every lookup', () => {
    const indexed = createPreviewInspectionIndex(data);
    expect(findPreviewMove(data, indexed, 1, 0)).toBe(2);
    expect(findPreviewMove(data, indexed, 1, 1)).toBe(3);
    expect(findPreviewMove(data, indexed, 1, 99)).toBe(4);
    expect(findPreviewMove(data, indexed, 7, 0)).toBeNull();
  });

  it('omits an invalid metadata range instead of falling back to a full scan', () => {
    const malformed = {
      ...data,
      metadata: { ...data.metadata, layerRanges: [{ id: 1, z: 0.4, firstSegment: 0, segmentCount: 99 }] },
    };
    const indexed = createPreviewInspectionIndex(malformed);
    expect(findPreviewMove(malformed, indexed, 1, 0)).toBeNull();
  });

  it('indexes exact and preceding source lines without rescanning moves', () => {
    const indexed = createPreviewSourceLineIndex(data);
    expect(indexed.mappedLines).toEqual([4, 7, 10, 11, 15, 20]);
    expect(sourceLineForPreviewMove(data, indexed, 3)).toBe(11);
    expect(findPreviewMoveForSourceLine(indexed, 11)).toBe(3);
    expect(findPreviewMoveForSourceLine(indexed, 12)).toBe(3);
    expect(findPreviewMoveForSourceLine(indexed, 3)).toBeNull();
  });

  it('uses the result-owned ordered ids without creating a duplicate line map', () => {
    const indexed = createPreviewSourceLineIndex({ ...data, sourceLineOrderValid: true });
    expect(indexed.orderedGcodeIds).toBe(data.gcodeIds);
    expect(indexed.mappedLines).toEqual([]);
    expect(indexed.moveByLine.size).toBe(0);
    expect(findPreviewMoveForSourceLine(indexed, 12)).toBe(3);
  });

  it('highlights duplicate source ids for both ordered and fallback indexes', () => {
    const duplicateIds = Uint32Array.from([4, 7, 11, 11, 15, 20]);
    const orderedData = { ...data, gcodeIds: duplicateIds, sourceLineOrderValid: true };
    const ordered = createPreviewSourceLineIndex(orderedData);
    expect(findPreviewMoveForSourceLine(ordered, 11)).toBe(2);
    expect(sourceLineForPreviewMove(orderedData, ordered, 3)).toBe(11);

    const fallbackData = { ...data, gcodeIds: duplicateIds };
    const fallback = createPreviewSourceLineIndex(fallbackData);
    expect(findPreviewMoveForSourceLine(fallback, 11)).toBe(2);
    expect(sourceLineForPreviewMove(fallbackData, fallback, 3)).toBe(11);
  });

  it('does not fabricate source navigation when mapping is unavailable', () => {
    const indexed = createPreviewSourceLineIndex({ ...data, metadata: { ...data.metadata, sourceLineMapping: { available: false, lineCount: 0 } } });
    expect(indexed.mappedLines).toEqual([]);
    expect(findPreviewMoveForSourceLine(indexed, 10)).toBeNull();
  });
});
