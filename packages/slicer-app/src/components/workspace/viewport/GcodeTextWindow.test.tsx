// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { GcodeTextWindow } from './GcodeTextWindow';
import type { ToolpathGeometry } from './useSliceResult';

const ROW_HEIGHT = 20;
const PAGE_LINES = 128;
const SCROLL_IDLE_DELAY_MS = 160;
const gcodeIds = Uint32Array.from([4, 7, 11]);

const data: ToolpathGeometry = {
  segmentCount: 3,
  palette: [],
  layerIds: Uint32Array.from([0, 0, 1]),
  moveOrders: Uint32Array.from([0, 1, 0]),
  gcodeIds,
  sourceLineOrderValid: true,
  sourceLineIndex: { moveByLine: new Map(), mappedLines: [], orderedGcodeIds: gcodeIds },
  features: new Uint32Array(3),
  moveTypes: new Uint8Array(3),
  extruderIds: new Uint8Array(3),
  metrics: {},
  ends: new Float32Array(9),
  metadata: {
    resultId: 42,
    layerRanges: [
      { id: 0, z: 0.2, firstSegment: 0, segmentCount: 2 },
      { id: 1, z: 0.4, firstSegment: 2, segmentCount: 1 },
    ],
    featurePalette: [],
    sourceLineMapping: { available: true, lineCount: 100 },
    sourceText: { available: true },
  },
  dispose: () => undefined,
};

const lateData: ToolpathGeometry = {
  ...data,
  gcodeIds: Uint32Array.from([4, 7, 12000]),
  sourceLineOrderValid: true,
  sourceLineIndex: {
    moveByLine: new Map(), mappedLines: [], orderedGcodeIds: Uint32Array.from([4, 7, 12000]),
  },
  metadata: { ...data.metadata!, sourceLineMapping: { available: true, lineCount: 12000 } },
};

describe('GcodeTextWindow', () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount(); root = undefined; document.body.innerHTML = '';
    useSlicerStore.getState().resetPreviewState();
    vi.useRealTimers();
  });

  it('loads source text lazily and keeps only visible line elements', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = { runtime: { readTextLines } } as unknown as PlatformCapabilities;
    useSlicerStore.getState().setPreviewBounds(1, 1, 42);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    expect(readTextLines).toHaveBeenCalledWith({ resultId: 42, startLine: 1, lineCount: 100 });
    expect(container.querySelector('[data-testid="gcode-text-window"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="gcode-line-"]').length).toBeLessThan(100);
    expect(container.querySelector('[data-testid="gcode-line-1"]')?.textContent).toContain('G1 X1');
  });

  it('maps exact and unmappable line clicks using the preceding move rule', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = { runtime: { readTextLines } } as unknown as PlatformCapabilities;
    useSlicerStore.getState().setPreviewBounds(1, 1, 42);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    await act(async () => { (container.querySelector('[data-testid="gcode-line-6"]') as HTMLElement).click(); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerEnd: 0, activeMoveEnd: 0 });
    await act(async () => { (container.querySelector('[data-testid="gcode-line-3"]') as HTMLElement).click(); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerEnd: 0, activeMoveEnd: 0 });
  });

  it('seeks directly to a late active page and centers its highlight', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: false,
      text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = { runtime: { readTextLines } } as unknown as PlatformCapabilities;
    useSlicerStore.getState().setPreviewBounds(1, 0, 42);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={lateData} onClose={() => undefined} /></PlatformProvider>); });
    expect(readTextLines).toHaveBeenCalledWith({ resultId: 42, startLine: 11905, lineCount: 96 });
    expect(readTextLines).not.toHaveBeenCalledWith(expect.objectContaining({ startLine: 1 }));
    expect(container.querySelector('[data-testid="gcode-line-12000"]')?.getAttribute('aria-current')).toBe('true');
    expect((container.querySelector('[data-testid="gcode-text-scroll"]') as HTMLElement).scrollTop).toBeGreaterThan(0);
  });

  it('loads a manually scrolled cache miss only after scrolling settles', async () => {
    vi.useFakeTimers();
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: false,
      text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = { runtime: { readTextLines } } as unknown as PlatformCapabilities;
    const scrollData = { ...lateData, metadata: { ...lateData.metadata!, sourceLineMapping: { available: true, lineCount: 12000 } } };
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={scrollData} onClose={() => undefined} /></PlatformProvider>); });
    const scroll = container.querySelector('[data-testid="gcode-text-scroll"]') as HTMLElement;
    const targetStartLine = PAGE_LINES * 2 + 1;
    expect(readTextLines).not.toHaveBeenCalledWith(expect.objectContaining({ startLine: targetStartLine }));

    await act(async () => {
      scroll.scrollTop = PAGE_LINES * 2 * ROW_HEIGHT;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY_MS - 1);
    });
    expect(readTextLines).not.toHaveBeenCalledWith(expect.objectContaining({ startLine: targetStartLine }));

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readTextLines).toHaveBeenCalledWith({ resultId: 42, startLine: targetStartLine, lineCount: PAGE_LINES });
  });

  it('resets the scroll idle debounce when scrolling continues', async () => {
    vi.useFakeTimers();
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: false,
      text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = { runtime: { readTextLines } } as unknown as PlatformCapabilities;
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={lateData} onClose={() => undefined} /></PlatformProvider>); });
    const scroll = container.querySelector('[data-testid="gcode-text-scroll"]') as HTMLElement;
    await act(async () => {
      scroll.scrollTop = PAGE_LINES * 2 * ROW_HEIGHT;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY_MS - 1);
      scroll.scrollTop = PAGE_LINES * 3 * ROW_HEIGHT;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(1);
    });
    expect(readTextLines).not.toHaveBeenCalledWith(expect.objectContaining({ startLine: PAGE_LINES * 2 + 1 }));
    expect(readTextLines).not.toHaveBeenCalledWith(expect.objectContaining({ startLine: PAGE_LINES * 3 + 1 }));
    await act(async () => {
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY_MS);
      await Promise.resolve();
    });
    expect(readTextLines).toHaveBeenCalledWith({ resultId: 42, startLine: PAGE_LINES * 3 + 1, lineCount: PAGE_LINES });
  });

  it('cancels a pending manual scroll load when the preview slider moves', async () => {
    vi.useFakeTimers();
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: false,
      text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = { runtime: { readTextLines } } as unknown as PlatformCapabilities;
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    useSlicerStore.getState().setPreviewBounds(1, 0, 42);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={lateData} onClose={() => undefined} /></PlatformProvider>); });
    const scroll = container.querySelector('[data-testid="gcode-text-scroll"]') as HTMLElement;
    const oldScrollPage = PAGE_LINES * 2 + 1;
    await act(async () => {
      scroll.scrollTop = PAGE_LINES * 2 * ROW_HEIGHT;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY_MS - 1);
      useSlicerStore.getState().setPreviewLayerEnd(0, 1);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY_MS);
      await Promise.resolve();
    });
    expect(readTextLines).not.toHaveBeenCalledWith(expect.objectContaining({ startLine: oldScrollPage }));
  });
});
