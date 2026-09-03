import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { usePlatform } from '@orca/platform-contract';
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

interface TextPage { startLine: number; lines: string[]; eof: boolean; }

function pageLines(page: PreviewTextLines): string[] {
  const lines = page.text.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(0, page.lineCount);
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
  const scrollTopRef = useRef(0);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineCount = data.metadata?.sourceLineMapping?.lineCount ?? 0;
  const inspectionIndex = useMemo(() => createPreviewInspectionIndex(data), [data]);
  const sourceIndex = data.sourceLineIndex;
  const activeMove = findPreviewMove(data, inspectionIndex, preview.visibleLayerEnd, preview.activeMoveEnd);
  const activeLine = activeMove === null || !sourceIndex ? null : sourceLineForPreviewMove(data, sourceIndex, activeMove);
  const totalRows = Math.max(1, lineCount);
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const visibleRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const lastRow = Math.min(totalRows, firstRow + visibleRows);

  useEffect(() => {
    cacheGenerationRef.current += 1;
    if (scrollIdleTimerRef.current !== null) {
      clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = null;
    }
    cacheRef.current.clear();
    loadingRef.current.clear();
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
      const page = await platform.runtime.readTextLines(request);
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
    if (!sourceTextAvailable(data)) return;
    const anchorRow = activeLine === null ? 0 : activeLine - 1;
    const pages = new Set<number>([Math.floor(anchorRow / PAGE_LINES)]);
    void Promise.all([...pages].map((page) => loadPage(page)));
  }, [activeLine, data, loadPage]);

  const scheduleVisiblePages = useCallback((nextScrollTop: number) => {
    if (!sourceTextAvailable(data)) return;
    const nextFirstRow = Math.max(0, Math.floor(nextScrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
    const nextLastRow = Math.min(
      totalRows,
      nextFirstRow + Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN_ROWS * 2,
    );
    const firstPage = Math.floor(nextFirstRow / PAGE_LINES);
    const lastPage = Math.floor(Math.max(nextFirstRow, nextLastRow - 1) / PAGE_LINES);
    const pages = new Set<number>();
    for (let page = firstPage; page <= lastPage; page += 1) pages.add(page);
    void Promise.all([...pages].map((page) => loadPage(page)));
  }, [data, loadPage, totalRows]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
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
    if (!cacheRef.current.has(pageNumber)) return;
    const targetTop = (activeLine - 1) * ROW_HEIGHT;
    const element = scrollRef.current;
    if (!element) return;
    const centeredTop = Math.max(0, targetTop - (VIEWPORT_HEIGHT - ROW_HEIGHT) / 2);
    if (Math.abs(element.scrollTop - centeredTop) > ROW_HEIGHT) {
      scrollTopRef.current = centeredTop;
      element.scrollTop = centeredTop;
      setScrollTop(centeredTop);
    }
  }, [activeLine, cacheVersion]);

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
    <section data-testid="gcode-text-window" aria-label="G-code text" className="pointer-events-auto absolute left-3 top-3 z-40 flex w-[min(58%,48rem)] flex-col overflow-hidden rounded-md border bg-card/95 text-card-foreground shadow-xl backdrop-blur">
      <header className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs font-semibold">
        <span>G-code</span>
        <Button variant="ghost" size="xs" aria-label="Close G-code text" data-testid="gcode-text-close" onClick={onClose}>Close</Button>
      </header>
      <div
        ref={scrollRef}
        data-testid="gcode-text-scroll"
        className="overflow-auto font-mono text-[11px] leading-5"
        style={{ height: VIEWPORT_HEIGHT }}
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
      <footer className="flex h-7 shrink-0 items-center justify-between border-t px-2 text-[10px] text-muted-foreground">
        <span>{activeLine ? `Active line ${activeLine}` : 'No mapped move'}</span>
        <span>{loading ? 'Loading…' : error ?? `Page cache ${cacheRef.current.size} / ${MAX_CACHED_PAGES}`}</span>
      </footer>
    </section>
  );
}
