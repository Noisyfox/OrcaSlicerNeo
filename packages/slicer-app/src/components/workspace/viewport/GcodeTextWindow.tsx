import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { PreviewTextChunk, PreviewTextChunkRequest } from '@slicer/client';
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
const CHUNK_BYTES = 64 * 1024;

interface TextDocument {
  text: string;
  byteEnd: number;
  eof: boolean;
}

function completeLines(document: TextDocument, lineCount: number): string[] {
  const pieces = document.text.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (!document.eof) pieces.pop();
  else if (pieces.at(-1) === '') pieces.pop();
  return pieces.slice(0, lineCount);
}

function appendChunk(document: TextDocument, chunk: PreviewTextChunk): TextDocument {
  const encoded = new TextEncoder().encode(chunk.text);
  if (chunk.offset > document.byteEnd) throw new Error('preview text chunk has a gap');
  const skip = Math.min(encoded.length, Math.max(0, document.byteEnd - chunk.offset));
  const suffix = new TextDecoder().decode(encoded.slice(skip));
  const nextEnd = Math.max(document.byteEnd, chunk.offset + encoded.length);
  if (nextEnd === document.byteEnd && !chunk.eof) throw new Error('preview text chunk made no progress');
  return { text: document.text + suffix, byteEnd: nextEnd, eof: chunk.eof };
}

function sourceTextAvailable(data: ToolpathGeometry): boolean {
  return data.metadata?.sourceLineMapping?.available === true &&
    data.metadata?.sourceText?.available === true &&
    data.sourceLineIndex !== undefined &&
    (data.metadata.sourceLineMapping.lineCount ?? 0) > 0;
}

/** Orca-style, read-only virtualized source view. The DOM contains only the
 * visible rows; source bytes are fetched through the worker in bounded chunks. */
export function GcodeTextWindow({ data, onClose }: { data: ToolpathGeometry; onClose: () => void }) {
  const platform = usePlatform();
  const preview = useSlicerStore((state) => state.preview);
  const setPreviewLayerEnd = useSlicerStore((state) => state.setPreviewLayerEnd);
  const setPreviewMoveEnd = useSlicerStore((state) => state.setPreviewMoveEnd);
  const [document, setDocument] = useState<TextDocument>({ text: '', byteEnd: 0, eof: false });
  const [scrollTop, setScrollTop] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const documentRef = useRef(document);
  const loadingRef = useRef(false);
  documentRef.current = document;
  const lineCount = data.metadata?.sourceLineMapping?.lineCount ?? 0;
  const lines = useMemo(() => completeLines(document, lineCount), [document, lineCount]);
  const inspectionIndex = useMemo(() => createPreviewInspectionIndex(data), [data]);
  // The result construction path builds this once. Opening/closing the
  // window and repeated line clicks only reuse the compact result-local index.
  const sourceIndex = data.sourceLineIndex;
  const activeMove = findPreviewMove(data, inspectionIndex, preview.visibleLayerEnd, preview.activeMoveEnd);
  const activeLine = activeMove === null || !sourceIndex ? null : sourceLineForPreviewMove(data, sourceIndex, activeMove);

  useEffect(() => {
    setDocument({ text: '', byteEnd: 0, eof: false });
    setScrollTop(0);
    setError(null);
    loadingRef.current = false;
  }, [data, data.metadata?.resultId]);

  const loadNextChunk = useCallback(async (): Promise<boolean> => {
    if (loadingRef.current || documentRef.current.eof) return false;
    const previousEnd = documentRef.current.byteEnd;
    loadingRef.current = true;
    setLoading(true);
    try {
      const request: PreviewTextChunkRequest = {
        resultId: data.metadata?.resultId ?? 0,
        offset: documentRef.current.byteEnd,
        length: CHUNK_BYTES,
      };
      const chunk = await platform.runtime.readTextChunk(request);
      const next = appendChunk(documentRef.current, chunk);
      documentRef.current = next;
      setDocument(next);
      setError(null);
      return next.byteEnd > previousEnd || next.eof;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [data.metadata?.resultId, platform.runtime]);

  // Open with one bounded request. If the active mapped line is beyond the
  // first chunk, progressively fetch until its line is available so slider
  // movement can always reveal the active source line.
  useEffect(() => {
    if (!sourceTextAvailable(data)) return;
    let cancelled = false;
    void (async () => {
      while (!cancelled && !documentRef.current.eof &&
             (documentRef.current.text.length === 0 ||
              completeLines(documentRef.current, lineCount).length < (activeLine ?? 1))) {
        if (!(await loadNextChunk())) break;
      }
    })();
    return () => { cancelled = true; };
  }, [activeLine, data, error, lineCount, loadNextChunk]);

  const totalRows = Math.max(1, lineCount);
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const visibleRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const lastRow = Math.min(totalRows, firstRow + visibleRows);

  const selectLine = (lineNumber: number) => {
    if (!sourceIndex) return;
    const move = findPreviewMoveForSourceLine(sourceIndex, lineNumber);
    // No mapped predecessor means the inspection position deliberately stays
    // unchanged; this also prevents comments/header lines from jumping to 0.
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
        data-testid="gcode-text-scroll"
        className="overflow-auto font-mono text-[11px] leading-5"
        style={{ height: VIEWPORT_HEIGHT }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: totalRows * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ position: 'absolute', top: firstRow * ROW_HEIGHT, left: 0, right: 0 }}>
            {Array.from({ length: lastRow - firstRow }, (_, offset) => {
              const row = firstRow + offset;
              const lineNumber = row + 1;
              const text = lines[row] ?? '';
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
        <span>{loading ? 'Loading…' : error ?? `${lines.length} / ${lineCount} lines`}</span>
      </footer>
    </section>
  );
}
