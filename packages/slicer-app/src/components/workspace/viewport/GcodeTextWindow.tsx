import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { normalizeGcodeTextWindowGeometry, usePlatform, type GcodeTextWindowGeometry } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { PreviewTextLines, PreviewTextLinesRequest } from '@slicer/client';
import type { ToolpathGeometry } from './useSliceResult';
import {
  createPreviewInspectionIndex,
  findPreviewMove,
  findPreviewMoveForSourceLine,
  maxMoveOrderForLayer,
  sourceLineForPreviewMove,
} from './previewSemantics';

const ROW_HEIGHT = 20;
const VIEWPORT_HEIGHT = 360;
const OVERSCAN_ROWS = 8;
const PAGE_LINES = 128;
const MAX_CACHED_PAGES = 6;
const SCROLL_IDLE_DELAY_MS = 160;
const DEFAULT_WINDOW_WIDTH = 560;
const DEFAULT_WINDOW_HEIGHT = VIEWPORT_HEIGHT + 36 + 28;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 220;
const MAX_WINDOW_WIDTH = 768;
const MAX_WINDOW_HEIGHT = 720;

type WindowGeometry = GcodeTextWindowGeometry;
type GestureKind = 'drag' | 'resize';
type PointerGesture = WindowGeometry & {
  kind: GestureKind;
  pointerId: number;
  startX: number;
  startY: number;
  target: HTMLElement;
};

const INITIAL_WINDOW_GEOMETRY: WindowGeometry = {
  left: 12,
  top: 12,
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
};

function viewportSize(windowElement: HTMLElement | null): { width: number; height: number } {
  const parent = windowElement?.parentElement;
  const rect = parent?.getBoundingClientRect();
  const width = rect?.width || parent?.clientWidth || window.innerWidth || DEFAULT_WINDOW_WIDTH + 24;
  const height = rect?.height || parent?.clientHeight || window.innerHeight || DEFAULT_WINDOW_HEIGHT + 24;
  return { width, height };
}

function clampGeometry(geometry: WindowGeometry, viewport: { width: number; height: number }): WindowGeometry {
  const widthLimit = Math.max(1, viewport.width);
  const heightLimit = Math.max(1, viewport.height);
  const minWidth = Math.min(MIN_WINDOW_WIDTH, widthLimit);
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, heightLimit);
  const width = Math.min(Math.max(minWidth, geometry.width), Math.min(MAX_WINDOW_WIDTH, widthLimit));
  const height = Math.min(Math.max(minHeight, geometry.height), Math.min(MAX_WINDOW_HEIGHT, heightLimit));
  return {
    left: Math.min(Math.max(0, geometry.left), Math.max(0, widthLimit - width)),
    top: Math.min(Math.max(0, geometry.top), Math.max(0, heightLimit - height)),
    width,
    height,
  };
}

function resizeGeometry(
  geometry: WindowGeometry,
  widthDelta: number,
  heightDelta: number,
  viewport: { width: number; height: number },
): WindowGeometry {
  const maxWidth = Math.max(1, Math.min(MAX_WINDOW_WIDTH, viewport.width - geometry.left));
  const maxHeight = Math.max(1, Math.min(MAX_WINDOW_HEIGHT, viewport.height - geometry.top));
  const minWidth = Math.min(MIN_WINDOW_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, maxHeight);
  return clampGeometry({
    ...geometry,
    width: Math.min(maxWidth, Math.max(minWidth, geometry.width + widthDelta)),
    height: Math.min(maxHeight, Math.max(minHeight, geometry.height + heightDelta)),
  }, viewport);
}

interface TextPage { startLine: number; lines: string[]; eof: boolean; }

function pageLines(page: PreviewTextLines): string[] {
  const lines = page.text.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(0, page.lineCount);
}

export function readCachedTextLines(bytes: Uint8Array, startLine: number, lineCount: number): PreviewTextLines {
  let currentLine = 1;
  let pageStart = -1;
  let pageEnd = -1;
  let foundLines = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (currentLine === startLine && pageStart < 0) pageStart = index;
    if (bytes[index] !== 0x0a) continue;
    if (currentLine >= startLine && foundLines < lineCount) {
      foundLines += 1;
      pageEnd = index;
      if (foundLines === lineCount) break;
    }
    currentLine += 1;
  }
  // A final line without a newline is still a source line. A trailing newline
  // does not create an additional empty source line, matching pageLines().
  if (foundLines < lineCount && pageStart >= 0 && currentLine >= startLine &&
      bytes[bytes.length - 1] !== 0x0a) {
    foundLines += 1;
    pageEnd = bytes.length;
  }
  if (pageStart < 0 || pageEnd < pageStart || foundLines === 0) {
    throw new Error('cached G-code source page is unavailable');
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(pageStart, pageEnd));
  return {
    startLine,
    lineCount: foundLines,
    text,
    eof: pageEnd === bytes.length || pageEnd + 1 === bytes.length,
  };
}

function sourceTextAvailable(data: ToolpathGeometry): boolean {
  return data.metadata?.sourceLineMapping?.available === true &&
    data.metadata?.sourceText?.available === true &&
    data.sourceLineIndex !== undefined &&
    (data.metadata.sourceLineMapping.lineCount ?? 0) > 0;
}

/** Orca-style, read-only source view with bounded, seekable line pages. */
export function GcodeTextWindow({ data, onClose }: { data: ToolpathGeometry; onClose: () => void }) {
  const platform = usePlatform();
  const titleId = useId();
  const preview = useSlicerStore((state) => state.preview);
  const setPreviewLayerEnd = useSlicerStore((state) => state.setPreviewLayerEnd);
  const setPreviewMoveEnd = useSlicerStore((state) => state.setPreviewMoveEnd);
  const [scrollTop, setScrollTop] = useState(0);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef(new Map<number, TextPage>());
  const loadingRef = useRef(new Set<number>());
  const cacheGenerationRef = useRef(0);
  const pendingCenterPageRef = useRef<number | null>(null);
  const scrollTopRef = useRef(0);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLElement>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const geometryRef = useRef<WindowGeometry>(INITIAL_WINDOW_GEOMETRY);
  const userGeometryRevisionRef = useRef(0);
  const pendingGeometrySaveRef = useRef<WindowGeometry | null>(null);
  const geometrySaveActiveRef = useRef(false);
  const [geometry, setGeometry] = useState<WindowGeometry>(INITIAL_WINDOW_GEOMETRY);
  const [geometryReady, setGeometryReady] = useState(false);
  const lineCount = data.metadata?.sourceLineMapping?.lineCount ?? 0;
  const inspectionIndex = useMemo(() => createPreviewInspectionIndex(data), [data]);
  const sourceIndex = data.sourceLineIndex;
  const activeMove = findPreviewMove(data, inspectionIndex, preview.visibleLayerEnd, preview.activeMoveEnd);
  const activeLine = activeMove === null || !sourceIndex ? null : sourceLineForPreviewMove(data, sourceIndex, activeMove);
  const totalRows = Math.max(1, lineCount);
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const textViewportHeight = Math.max(120, geometry.height - 36 - 28);
  const visibleRows = Math.ceil(textViewportHeight / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const lastRow = Math.min(totalRows, firstRow + visibleRows);

  const applyGeometry = useCallback((next: WindowGeometry, userInitiated = false) => {
    const bounded = clampGeometry(next, viewportSize(windowRef.current));
    if (userInitiated) userGeometryRevisionRef.current += 1;
    geometryRef.current = bounded;
    setGeometry(bounded);
    return bounded;
  }, []);

  const persistGeometry = useCallback((next: WindowGeometry) => {
    pendingGeometrySaveRef.current = { ...next };
    if (geometrySaveActiveRef.current) return;
    geometrySaveActiveRef.current = true;

    const drain = async () => {
      while (pendingGeometrySaveRef.current) {
        const geometryToSave = pendingGeometrySaveRef.current;
        pendingGeometrySaveRef.current = null;
        try {
          const prefs = await platform.preferences.load();
          // A newer pointer/keyboard gesture arrived while loading. Let the
          // next pass load the latest document and save only that geometry.
          if (pendingGeometrySaveRef.current) continue;
          await platform.preferences.save({
            ...prefs,
            ui: { ...prefs.ui, gcodeTextWindow: geometryToSave },
          });
        } catch {
          // Persistence is best-effort; the overlay remains usable if storage
          // is unavailable or the host rejects a write.
        }
      }
      geometrySaveActiveRef.current = false;
      if (pendingGeometrySaveRef.current) {
        persistGeometry(pendingGeometrySaveRef.current);
      }
    };
    void drain();
  }, [platform.preferences]);

  // Size the initial window from the viewport without persisting it. The
  // fixed fallback keeps the component usable in a not-yet-laid-out host.
  useLayoutEffect(() => {
    const viewport = viewportSize(windowRef.current);
    const width = viewport.width > DEFAULT_WINDOW_WIDTH
      ? Math.min(MAX_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, viewport.width * 0.58))
      : DEFAULT_WINDOW_WIDTH;
    const height = viewport.height > DEFAULT_WINDOW_HEIGHT + 24
      ? DEFAULT_WINDOW_HEIGHT
      : Math.max(MIN_WINDOW_HEIGHT, viewport.height - 24);
    applyGeometry(clampGeometry({ ...INITIAL_WINDOW_GEOMETRY, width, height }, viewport));
  }, [applyGeometry]);

  useEffect(() => {
    let active = true;
    const revisionAtLoad = userGeometryRevisionRef.current;
    void platform.preferences.load().then((prefs) => {
      if (!active || userGeometryRevisionRef.current !== revisionAtLoad) return;
      const saved = normalizeGcodeTextWindowGeometry(prefs.ui.gcodeTextWindow);
      if (saved) applyGeometry(saved);
    }).catch(() => undefined).finally(() => {
      // Keep the mounted window hidden until the first geometry decision has
      // completed. A rejected or malformed preference load still reveals the
      // already prepared viewport-sized fallback instead of trapping it.
      if (active) setGeometryReady(true);
    });
    return () => { active = false; };
  }, [applyGeometry, platform.preferences]);

  useEffect(() => {
    const handleViewportResize = () => applyGeometry(geometryRef.current);
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, [applyGeometry]);

  const releasePointerCapture = useCallback((gesture: PointerGesture) => {
    if (typeof gesture.target.releasePointerCapture !== 'function') return;
    try {
      if (gesture.target.hasPointerCapture?.(gesture.pointerId)) {
        gesture.target.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      // The browser may have already released capture during cancellation.
    }
  }, []);

  const clearPointerGesture = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    releasePointerCapture(gesture);
    gestureRef.current = null;
  }, [releasePointerCapture]);

  useEffect(() => clearPointerGesture, [clearPointerGesture]);

  const beginPointerGesture = useCallback((event: React.PointerEvent<HTMLElement>, kind: GestureKind) => {
    if (event.button !== 0 || gestureRef.current) return;
    if (kind === 'drag' && (event.target as Element | null)?.closest('button')) return;
    const target = event.currentTarget;
    const base = geometryRef.current;
    gestureRef.current = {
      ...base,
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      target,
    };
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can fail for synthetic events or a detached target.
      }
    }
    event.preventDefault();
  }, []);

  const updatePointerGesture = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (gesture.kind === 'drag') {
      applyGeometry({ ...gesture, left: gesture.left + dx, top: gesture.top + dy }, true);
    } else {
      applyGeometry(resizeGeometry(gesture, dx, dy, viewportSize(windowRef.current)), true);
    }
    event.preventDefault();
  }, [applyGeometry]);

  const endPointerGesture = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    clearPointerGesture();
    persistGeometry(geometryRef.current);
  }, [clearPointerGesture, persistGeometry]);

  const resizeWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const amount = event.shiftKey ? 50 : 10;
    let widthDelta = 0;
    let heightDelta = 0;
    if (event.key === 'ArrowLeft') widthDelta = -amount;
    else if (event.key === 'ArrowRight') widthDelta = amount;
    else if (event.key === 'ArrowUp') heightDelta = -amount;
    else if (event.key === 'ArrowDown') heightDelta = amount;
    else return;
    const next = applyGeometry(resizeGeometry(geometryRef.current, widthDelta, heightDelta, viewportSize(windowRef.current)), true);
    persistGeometry(next);
    event.preventDefault();
    event.stopPropagation();
  }, [applyGeometry, persistGeometry]);

  useEffect(() => {
    cacheGenerationRef.current += 1;
    if (scrollIdleTimerRef.current !== null) {
      clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = null;
    }
    cacheRef.current.clear();
    loadingRef.current.clear();
    pendingCenterPageRef.current = null;
    scrollTopRef.current = 0;
    setLoading(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
    setCacheVersion((version) => version + 1);
    setError(null);

    return () => {
      cacheGenerationRef.current += 1;
      if (scrollIdleTimerRef.current !== null) {
        clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
    };
  }, [data, data.metadata?.resultId]);

  const loadPage = useCallback(async (pageNumber: number): Promise<void> => {
    if (cacheRef.current.has(pageNumber) || loadingRef.current.has(pageNumber)) return;
    const startLine = pageNumber * PAGE_LINES + 1;
    if (startLine > lineCount) return;
    const generation = cacheGenerationRef.current;
    loadingRef.current.add(pageNumber);
    setLoading(true);
    try {
      const request: PreviewTextLinesRequest = {
        resultId: data.metadata?.resultId ?? 0,
        startLine,
        lineCount: Math.min(PAGE_LINES, lineCount - startLine + 1),
      };
      const page = data.sourceTextBytes
        ? readCachedTextLines(data.sourceTextBytes, startLine, request.lineCount)
        : await platform.runtime.readTextLines(request);
      if (cacheGenerationRef.current === generation) {
        cacheRef.current.set(pageNumber, { startLine: page.startLine, lines: pageLines(page), eof: page.eof });
        while (cacheRef.current.size > MAX_CACHED_PAGES) {
          const oldest = cacheRef.current.keys().next().value;
          if (oldest === undefined) break;
          cacheRef.current.delete(oldest);
        }
        setError(null);
        setCacheVersion((version) => version + 1);
      }
    } catch (cause) {
      if (cacheGenerationRef.current === generation) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (cacheGenerationRef.current === generation) {
        loadingRef.current.delete(pageNumber);
        setLoading(loadingRef.current.size > 0);
      }
    }
  }, [data.metadata?.resultId, lineCount, platform.runtime]);

  // Direct slider/navigation changes load the active page immediately. This
  // keeps the selected line responsive without making manual scroll events
  // compete with it.
  useEffect(() => {
    if (scrollIdleTimerRef.current !== null) {
      clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = null;
    }
    pendingCenterPageRef.current = null;
    if (!sourceTextAvailable(data)) return;
    const anchorRow = activeLine === null ? 0 : activeLine - 1;
    const pageNumber = Math.floor(anchorRow / PAGE_LINES);
    pendingCenterPageRef.current = activeLine === null ? null : pageNumber;
    const pages = new Set<number>([pageNumber]);
    void Promise.all([...pages].map((page) => loadPage(page)));
  }, [activeLine, data, loadPage]);

  const scheduleVisiblePages = useCallback((nextScrollTop: number) => {
    if (!sourceTextAvailable(data)) return;
    const nextFirstRow = Math.max(0, Math.floor(nextScrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
    const nextLastRow = Math.min(
      totalRows,
      nextFirstRow + Math.ceil(textViewportHeight / ROW_HEIGHT) + OVERSCAN_ROWS * 2,
    );
    const firstPage = Math.floor(nextFirstRow / PAGE_LINES);
    const lastPage = Math.floor(Math.max(nextFirstRow, nextLastRow - 1) / PAGE_LINES);
    const pages = new Set<number>();
    for (let page = firstPage; page <= lastPage; page += 1) pages.add(page);
    void Promise.all([...pages].map((page) => loadPage(page)));
  }, [data, loadPage, textViewportHeight, totalRows]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    // A user scroll supersedes an outstanding active-line centering request.
    // Page cache updates must not move the viewport back to the active line.
    pendingCenterPageRef.current = null;
    scrollTopRef.current = nextScrollTop;
    setScrollTop(nextScrollTop);
    if (scrollIdleTimerRef.current !== null) clearTimeout(scrollIdleTimerRef.current);
    const generation = cacheGenerationRef.current;
    scrollIdleTimerRef.current = setTimeout(() => {
      scrollIdleTimerRef.current = null;
      if (cacheGenerationRef.current === generation) scheduleVisiblePages(scrollTopRef.current);
    }, SCROLL_IDLE_DELAY_MS);
  }, [scheduleVisiblePages]);

  // Once the active page has resolved, center its row in the viewport so the
  // active-line highlight is always visible after slider navigation.
  useEffect(() => {
    if (activeLine === null) return;
    const pageNumber = Math.floor((activeLine - 1) / PAGE_LINES);
    if (pendingCenterPageRef.current !== pageNumber) return;
    if (!cacheRef.current.has(pageNumber)) return;
    const targetTop = (activeLine - 1) * ROW_HEIGHT;
    const element = scrollRef.current;
    if (!element) return;
    const centeredTop = Math.max(0, targetTop - (textViewportHeight - ROW_HEIGHT) / 2);
    pendingCenterPageRef.current = null;
    if (Math.abs(element.scrollTop - centeredTop) > ROW_HEIGHT) {
      scrollTopRef.current = centeredTop;
      element.scrollTop = centeredTop;
      setScrollTop(centeredTop);
    }
  }, [activeLine, cacheVersion, textViewportHeight]);

  const selectLine = (lineNumber: number) => {
    if (!sourceIndex) return;
    const move = findPreviewMoveForSourceLine(sourceIndex, lineNumber);
    if (move === null) return;
    const layer = data.layerIds[move] ?? preview.visibleLayerEnd;
    const order = data.moveOrders[move] ?? 0;
    setPreviewLayerEnd(layer, maxMoveOrderForLayer(data, layer));
    setPreviewMoveEnd(order);
  };

  if (!sourceTextAvailable(data) || !sourceIndex) return null;

  return (
    <section
      ref={windowRef}
      data-testid="gcode-text-window"
      aria-labelledby={titleId}
      className="pointer-events-auto absolute z-40 flex min-w-0 flex-col overflow-hidden rounded-md border bg-card/95 text-card-foreground shadow-xl backdrop-blur"
      aria-hidden={!geometryReady}
      style={{
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        height: geometry.height,
        visibility: geometryReady ? 'visible' : 'hidden',
        pointerEvents: geometryReady ? 'auto' : 'none',
      }}
    >
      <header
        data-testid="gcode-text-header"
        className="flex h-9 shrink-0 cursor-move select-none items-center justify-between border-b px-3 text-xs font-semibold"
        style={{ touchAction: 'none' }}
        onPointerDown={(event) => beginPointerGesture(event, 'drag')}
        onPointerMove={updatePointerGesture}
        onPointerUp={endPointerGesture}
        onPointerCancel={endPointerGesture}
        onLostPointerCapture={endPointerGesture}
      >
        <span id={titleId}>G-code</span>
        <Button variant="ghost" size="xs" aria-label="Close G-code text" title="Close G-code text" data-testid="gcode-text-close" onClick={onClose}>
          <XIcon aria-hidden="true" className="pointer-events-none" />
        </Button>
      </header>
      <div
        ref={scrollRef}
        data-testid="gcode-text-scroll"
        className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5"
        style={{ height: textViewportHeight }}
        onScroll={handleScroll}
      >
        <div style={{ height: totalRows * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ position: 'absolute', top: firstRow * ROW_HEIGHT, left: 0, right: 0 }}>
            {Array.from({ length: lastRow - firstRow }, (_, offset) => {
              const row = firstRow + offset;
              const lineNumber = row + 1;
              const page = cacheRef.current.get(Math.floor(row / PAGE_LINES));
              const text = page?.lines[row % PAGE_LINES] ?? '';
              const active = activeLine === lineNumber;
              return (
                <button
                  type="button"
                  key={lineNumber}
                  data-testid={`gcode-line-${lineNumber}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => selectLine(lineNumber)}
                  className={`flex h-5 w-full items-start gap-3 px-2 text-left whitespace-pre ${active ? 'bg-primary/20 text-primary' : 'hover:bg-muted/60'}`}
                >
                  <span className="w-12 shrink-0 select-none text-right text-muted-foreground">{lineNumber}</span>
                  <span className="min-w-0 truncate">{text}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <footer className="flex h-7 shrink-0 items-center justify-between border-t px-2 pr-6 text-[10px] text-muted-foreground">
        <span>{activeLine ? `Active line ${activeLine}` : 'No mapped move'}</span>
        <span>{loading ? 'Loading…' : error ?? `Page cache ${cacheRef.current.size} / ${MAX_CACHED_PAGES}`}</span>
      </footer>
      <button
        type="button"
        data-testid="gcode-text-resize"
        aria-label="Resize G-code text window"
        title="Resize G-code text window"
        className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize touch-none bg-transparent p-0"
        onPointerDown={(event) => beginPointerGesture(event, 'resize')}
        onPointerMove={updatePointerGesture}
        onPointerUp={endPointerGesture}
        onPointerCancel={endPointerGesture}
        onLostPointerCapture={endPointerGesture}
        onKeyDown={resizeWithKeyboard}
      >
        <span aria-hidden="true" className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 border-b-2 border-r-2 border-muted-foreground/70" />
      </button>
    </section>
  );
}
