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

function setViewportSize(container: HTMLElement, width = 800, height = 600) {
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: height });
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
    width, height, toJSON: () => undefined,
  });
}

function addPointerCaptureMock(element: HTMLElement) {
  let captured = false;
  const setPointerCapture = vi.fn(() => { captured = true; });
  const releasePointerCapture = vi.fn(() => { captured = false; });
  Object.defineProperty(element, 'setPointerCapture', { configurable: true, value: setPointerCapture });
  Object.defineProperty(element, 'hasPointerCapture', { configurable: true, value: () => captured });
  Object.defineProperty(element, 'releasePointerCapture', { configurable: true, value: releasePointerCapture });
  return { setPointerCapture, releasePointerCapture };
}

function dispatchPointer(target: HTMLElement, type: string, pointerId: number, clientX: number, clientY: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ pointerId, clientX, clientY, button: 0 })) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  target.dispatchEvent(event);
}

function testPlatform(readTextLines: ReturnType<typeof vi.fn>, preferences = { version: 1 as const, selectedProfiles: {}, ui: {} }) {
  return {
    runtime: { readTextLines },
    preferences: {
      load: vi.fn(async () => preferences),
      save: vi.fn(async () => undefined),
    },
  } as unknown as PlatformCapabilities;
}

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
    const platform = testPlatform(readTextLines);
    useSlicerStore.getState().setPreviewBounds(1, 1, 42);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    expect(readTextLines).toHaveBeenCalledWith({ resultId: 42, startLine: 1, lineCount: 100 });
    expect(container.querySelector('[data-testid="gcode-text-window"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="gcode-line-"]').length).toBeLessThan(100);
    expect(container.querySelector('[data-testid="gcode-line-1"]')?.textContent).toContain('G1 X1');
  });

  it('moves with the title bar, clamps to the viewport, and does not drag from Close', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const onClose = vi.fn();
    const platform = testPlatform(readTextLines);
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={onClose} /></PlatformProvider>); });
    const windowElement = container.querySelector('[data-testid="gcode-text-window"]') as HTMLElement;
    const header = container.querySelector('[data-testid="gcode-text-header"]') as HTMLElement;
    const close = container.querySelector('[data-testid="gcode-text-close"]') as HTMLElement;
    const capture = addPointerCaptureMock(header);
    const initialLeft = parseFloat(windowElement.style.left);
    const initialTop = parseFloat(windowElement.style.top);

    await act(async () => {
      dispatchPointer(header, 'pointerdown', 1, 100, 100);
      dispatchPointer(header, 'pointermove', 1, 250, 180);
      dispatchPointer(header, 'pointerup', 1, 250, 180);
    });
    expect(parseFloat(windowElement.style.left)).toBe(initialLeft + 150);
    expect(parseFloat(windowElement.style.top)).toBe(initialTop + 80);
    expect(capture.setPointerCapture).toHaveBeenCalledWith(1);
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(1);

    await act(async () => {
      dispatchPointer(header, 'pointerdown', 2, 0, 0);
      dispatchPointer(header, 'pointermove', 2, -1000, -1000);
      dispatchPointer(header, 'pointerup', 2, -1000, -1000);
    });
    expect(windowElement.style.left).toBe('0px');
    expect(windowElement.style.top).toBe('0px');

    await act(async () => {
      dispatchPointer(close, 'pointerdown', 3, 20, 20);
      dispatchPointer(header, 'pointermove', 3, 300, 300);
    });
    expect(windowElement.style.left).toBe('0px');
    expect(windowElement.style.top).toBe('0px');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('resizes from the visible corner handle, clamps dimensions, and supports keyboard resizing', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = testPlatform(readTextLines);
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    const windowElement = container.querySelector('[data-testid="gcode-text-window"]') as HTMLElement;
    const handle = container.querySelector('[data-testid="gcode-text-resize"]') as HTMLElement;
    const capture = addPointerCaptureMock(handle);
    expect(handle.getAttribute('aria-label')).toBe('Resize G-code text window');

    await act(async () => {
      dispatchPointer(handle, 'pointerdown', 4, 0, 0);
      dispatchPointer(handle, 'pointermove', 4, 100, 100);
      dispatchPointer(handle, 'pointerup', 4, 100, 100);
    });
    expect(parseFloat(windowElement.style.width)).toBe(564);
    expect(parseFloat(windowElement.style.height)).toBe(524);
    expect(capture.setPointerCapture).toHaveBeenCalledWith(4);
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(4);

    await act(async () => {
      dispatchPointer(handle, 'pointerdown', 5, 0, 0);
      dispatchPointer(handle, 'pointermove', 5, -1000, -1000);
      dispatchPointer(handle, 'pointercancel', 5, -1000, -1000);
    });
    expect(parseFloat(windowElement.style.width)).toBe(320);
    expect(parseFloat(windowElement.style.height)).toBe(220);
    expect(handle.getAttribute('aria-label')).toBe('Resize G-code text window');

    await act(async () => {
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    });
    expect(parseFloat(windowElement.style.width)).toBe(330);
    expect(parseFloat(windowElement.style.height)).toBe(270);

    await act(async () => {
      dispatchPointer(handle, 'pointerdown', 6, 0, 0);
      dispatchPointer(handle, 'pointermove', 6, 1000, 1000);
      dispatchPointer(handle, 'pointerup', 6, 1000, 1000);
    });
    expect(parseFloat(windowElement.style.width)).toBe(768);
    expect(parseFloat(windowElement.style.height)).toBe(588);
    expect(parseFloat(windowElement.style.left) + parseFloat(windowElement.style.width)).toBeLessThanOrEqual(800);
    expect(parseFloat(windowElement.style.top) + parseFloat(windowElement.style.height)).toBeLessThanOrEqual(600);
  });

  it('restores saved geometry once and clamps it to a small viewport', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: 'G1 X1',
    }));
    const preferences = {
      version: 1 as const,
      selectedProfiles: { printer: 'saved-printer' },
      ui: { sidebarWidth: 280, gcodeTextWindow: { left: 700, top: 500, width: 600, height: 700 } },
    };
    const platform = testPlatform(readTextLines, preferences);
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container, 400, 260); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    const windowElement = container.querySelector('[data-testid="gcode-text-window"]') as HTMLElement;
    expect(windowElement.style.width).toBe('400px');
    expect(windowElement.style.height).toBe('260px');
    expect(windowElement.style.left).toBe('0px');
    expect(windowElement.style.top).toBe('0px');
    expect(platform.preferences.load).toHaveBeenCalledTimes(1);
  });

  it('keeps the window hidden until deferred geometry preferences resolve', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: 'G1 X1',
    }));
    type StoredPreferences = {
      version: 1;
      selectedProfiles: {};
      ui: { gcodeTextWindow: { left: number; top: number; width: number; height: number } };
    };
    const loads: Array<(value: StoredPreferences) => void> = [];
    const platform = {
      runtime: { readTextLines },
      preferences: {
        load: vi.fn(() => new Promise<StoredPreferences>((resolve) => loads.push(resolve))),
        save: vi.fn(async () => undefined),
      },
    } as unknown as PlatformCapabilities;
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container); root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>);
    });
    const windowElement = container.querySelector('[data-testid="gcode-text-window"]') as HTMLElement;
    expect(loads).toHaveLength(1);
    expect(windowElement.style.visibility).toBe('hidden');
    expect(windowElement.style.pointerEvents).toBe('none');
    expect(windowElement.style.width).toBe('463.99999999999994px');

    await act(async () => {
      loads[0]({ version: 1, selectedProfiles: {}, ui: { gcodeTextWindow: { left: 80, top: 40, width: 420, height: 300 } } });
      await Promise.resolve();
    });
    expect(windowElement.style.visibility).toBe('visible');
    expect(windowElement.style.pointerEvents).toBe('auto');
    expect(windowElement.style.left).toBe('80px');
    expect(windowElement.style.top).toBe('40px');
    expect(windowElement.style.width).toBe('420px');
    expect(windowElement.style.height).toBe('300px');
  });

  it('reveals the fallback geometry when preferences are rejected or malformed', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: 'G1 X1',
    }));
    const platform = testPlatform(readTextLines, {
      version: 1,
      selectedProfiles: {},
      ui: { gcodeTextWindow: { left: 'bad', top: 0, width: 500, height: 400 } },
    } as never);
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container); root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>);
    });
    const windowElement = container.querySelector('[data-testid="gcode-text-window"]') as HTMLElement;
    expect(windowElement.style.visibility).toBe('visible');
    expect(windowElement.style.pointerEvents).toBe('auto');
    expect(windowElement.style.left).toBe('12px');
    expect(windowElement.style.top).toBe('12px');

    root?.unmount(); root = undefined;
    const rejectedPlatform = {
      ...testPlatform(readTextLines),
      preferences: {
        load: vi.fn(async () => { throw new Error('unavailable'); }),
        save: vi.fn(async () => undefined),
      },
    } as unknown as PlatformCapabilities;
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={rejectedPlatform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>);
    });
    expect((container.querySelector('[data-testid="gcode-text-window"]') as HTMLElement).style.visibility).toBe('visible');
  });

  it('still restores saved geometry when a viewport resize happens before loading finishes', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: 'G1 X1',
    }));
    type StoredPreferences = {
      version: 1;
      selectedProfiles: {};
      ui: { gcodeTextWindow: { left: number; top: number; width: number; height: number } };
    };
    const savedGeometry = { left: 50, top: 20, width: 320, height: 220 };
    const loads: Array<(value: StoredPreferences) => void> = [];
    const platform = {
      runtime: { readTextLines },
      preferences: {
        load: vi.fn(() => new Promise<StoredPreferences>((resolve) => loads.push(resolve))),
        save: vi.fn(async () => undefined),
      },
    } as unknown as PlatformCapabilities;
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    setViewportSize(container, 400, 260);
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    await act(async () => {
      loads[0]({ version: 1, selectedProfiles: {}, ui: { gcodeTextWindow: savedGeometry } });
      await Promise.resolve();
      await Promise.resolve();
    });
    const windowElement = container.querySelector('[data-testid="gcode-text-window"]') as HTMLElement;
    expect(windowElement.style.left).toBe('50px');
    expect(windowElement.style.top).toBe('20px');
    expect(windowElement.style.width).toBe('320px');
    expect(windowElement.style.height).toBe('220px');
  });

  it('persists only the final pointer geometry and preserves unrelated preferences', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: 'G1 X1',
    }));
    const preferences = {
      version: 1 as const,
      selectedProfiles: { printer: 'saved-printer' },
      ui: { sidebarWidth: 280, switchToDeviceAfterSend: false },
    };
    const platform = testPlatform(readTextLines, preferences);
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    const header = container.querySelector('[data-testid="gcode-text-header"]') as HTMLElement;
    addPointerCaptureMock(header);
    await act(async () => {
      dispatchPointer(header, 'pointerdown', 9, 100, 100);
      dispatchPointer(header, 'pointermove', 9, 140, 150);
    });
    expect(platform.preferences.save).not.toHaveBeenCalled();
    await act(async () => {
      dispatchPointer(header, 'pointerup', 9, 140, 150);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(platform.preferences.save).toHaveBeenCalledTimes(1);
    expect(platform.preferences.save).toHaveBeenCalledWith({
      ...preferences,
      ui: { ...preferences.ui, gcodeTextWindow: { left: 52, top: 62, width: 463.99999999999994, height: 424 } },
    });
  });

  it('persists keyboard resize immediately after the key gesture', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: 'G1 X1',
    }));
    const platform = testPlatform(readTextLines);
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    const handle = container.querySelector('[data-testid="gcode-text-resize"]') as HTMLElement;
    await act(async () => {
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(platform.preferences.save).toHaveBeenCalledWith(expect.objectContaining({
      ui: expect.objectContaining({ gcodeTextWindow: expect.objectContaining({ width: 473.99999999999994 }) }),
    }));
  });

  it('does not let a late initial preference load overwrite a newer drag', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: 'G1 X1',
    }));
    const loads: Array<(value: { version: 1; selectedProfiles: {}; ui: { gcodeTextWindow: { left: number; top: number; width: number; height: number } } }) => void> = [];
    const savedGeometry = { left: 300, top: 200, width: 500, height: 400 };
    const platform = {
      runtime: { readTextLines },
      preferences: {
        load: vi.fn(() => new Promise((resolve) => loads.push(resolve))),
        save: vi.fn(async () => undefined),
      },
    } as unknown as PlatformCapabilities;
    const container = document.createElement('div'); document.body.append(container); setViewportSize(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    const windowElement = container.querySelector('[data-testid="gcode-text-window"]') as HTMLElement;
    const header = container.querySelector('[data-testid="gcode-text-header"]') as HTMLElement;
    addPointerCaptureMock(header);
    await act(async () => {
      dispatchPointer(header, 'pointerdown', 10, 100, 100);
      dispatchPointer(header, 'pointermove', 10, 140, 150);
      dispatchPointer(header, 'pointerup', 10, 140, 150);
    });
    expect(loads).toHaveLength(2);
    expect(windowElement.style.left).toBe('52px');
    expect(windowElement.style.top).toBe('62px');

    await act(async () => {
      loads[0]({ version: 1, selectedProfiles: {}, ui: { gcodeTextWindow: savedGeometry } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(windowElement.style.left).toBe('52px');
    expect(windowElement.style.top).toBe('62px');
    loads[1]({ version: 1, selectedProfiles: {}, ui: { gcodeTextWindow: savedGeometry } });
  });

  it('maps exact and unmappable line clicks using the preceding move rule', async () => {
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: true, text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = testPlatform(readTextLines);
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
    const platform = testPlatform(readTextLines);
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
    const platform = testPlatform(readTextLines);
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

  it('keeps the manual scroll position when the uncached page resolves', async () => {
    vi.useFakeTimers();
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: false,
      text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = testPlatform(readTextLines);
    const scrollData = { ...lateData, metadata: { ...lateData.metadata!, sourceLineMapping: { available: true, lineCount: 12000 } } };
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={scrollData} onClose={() => undefined} /></PlatformProvider>); });
    const scroll = container.querySelector('[data-testid="gcode-text-scroll"]') as HTMLElement;
    const manualScrollTop = PAGE_LINES * 2 * ROW_HEIGHT;

    await act(async () => {
      scroll.scrollTop = manualScrollTop;
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readTextLines).toHaveBeenCalledWith({ resultId: 42, startLine: PAGE_LINES * 2 + 1, lineCount: PAGE_LINES });
    expect(scroll.scrollTop).toBe(manualScrollTop);
  });

  it('resets the scroll idle debounce when scrolling continues', async () => {
    vi.useFakeTimers();
    const readTextLines = vi.fn(async ({ resultId, startLine, lineCount }: { resultId: number; startLine: number; lineCount: number }) => ({
      resultId, startLine, lineCount, eof: false,
      text: Array.from({ length: lineCount }, (_, i) => `G1 X${startLine + i}`).join('\n'),
    }));
    const platform = testPlatform(readTextLines);
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
    const platform = testPlatform(readTextLines);
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
