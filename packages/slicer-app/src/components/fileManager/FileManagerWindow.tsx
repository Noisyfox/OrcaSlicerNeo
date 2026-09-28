import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from 'lucide-react';
import type { FilesystemEntry } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface WindowGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

type WindowOperation =
  | { kind: 'listing'; path: string }
  | { kind: 'downloading'; fileName: string }
  | null;

type PointerGesture = WindowGeometry & {
  kind: 'drag' | 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  target: HTMLElement;
};

const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const MAX_WIDTH = 960;
const MAX_HEIGHT = 720;
const DEFAULT_GEOMETRY: WindowGeometry = { left: 24, top: 48, width: 600, height: 420 };

function viewportSize(): { width: number; height: number } {
  return {
    width: Math.max(1, window.innerWidth || DEFAULT_GEOMETRY.width + 24),
    height: Math.max(1, window.innerHeight || DEFAULT_GEOMETRY.height + 24),
  };
}

function clampGeometry(geometry: WindowGeometry, viewport: { width: number; height: number }): WindowGeometry {
  const maxWidth = Math.max(1, Math.min(MAX_WIDTH, viewport.width));
  const maxHeight = Math.max(1, Math.min(MAX_HEIGHT, viewport.height));
  const width = Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), geometry.width));
  const height = Math.min(maxHeight, Math.max(Math.min(MIN_HEIGHT, maxHeight), geometry.height));
  return {
    left: Math.min(Math.max(0, geometry.left), Math.max(0, viewport.width - width)),
    top: Math.min(Math.max(0, geometry.top), Math.max(0, viewport.height - height)),
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
  const maxWidth = Math.max(1, Math.min(MAX_WIDTH, viewport.width - geometry.left));
  const maxHeight = Math.max(1, Math.min(MAX_HEIGHT, viewport.height - geometry.top));
  return clampGeometry({
    ...geometry,
    width: Math.min(maxWidth, Math.max(Math.min(MIN_WIDTH, maxWidth), geometry.width + widthDelta)),
    height: Math.min(maxHeight, Math.max(Math.min(MIN_HEIGHT, maxHeight), geometry.height + heightDelta)),
  }, viewport);
}

function childPath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

function parentPath(directory: string): string {
  if (directory === '/') return '/';
  const lastSlash = directory.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : directory.slice(0, lastSlash);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setPointerCapture(target: HTMLElement, pointerId: number): void {
  if (typeof target.setPointerCapture !== 'function') return;
  try { target.setPointerCapture(pointerId); } catch { /* synthetic or detached targets may reject capture */ }
}

function releasePointerCapture(gesture: PointerGesture): void {
  if (typeof gesture.target.releasePointerCapture !== 'function') return;
  try {
    if (gesture.target.hasPointerCapture?.(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
  } catch {
    // The browser may already have released capture during cancellation.
  }
}

/** A nonmodal, app-level view of the current Worker-owned Emscripten filesystem. */
export function FileManagerWindow({ focusRequest, onClose }: { focusRequest: number; onClose: () => void }) {
  const platform = usePlatform();
  const titleId = `file-manager-title-${focusRequest}`;
  const windowRef = useRef<HTMLElement | null>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const mountedRef = useRef(false);
  const requestRevisionRef = useRef(0);
  const operationRef = useRef<WindowOperation>(null);
  const currentPathRef = useRef('/');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<FilesystemEntry[]>([]);
  const [operation, setOperation] = useState<WindowOperation>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [geometry, setGeometry] = useState<WindowGeometry>(DEFAULT_GEOMETRY);

  const navigateTo = useCallback(async (directory: string) => {
    if (operationRef.current !== null) return;
    operationRef.current = { kind: 'listing', path: directory };
    setOperation(operationRef.current);
    setError(null);
    setStatusMessage('');
    const revision = ++requestRevisionRef.current;
    try {
      const nextEntries = await platform.runtime.listFilesystemDirectory(directory);
      if (!mountedRef.current || revision !== requestRevisionRef.current) return;
      currentPathRef.current = directory;
      setPath(directory);
      setEntries(nextEntries);
    } catch (cause) {
      if (mountedRef.current && revision === requestRevisionRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current && revision === requestRevisionRef.current) {
        operationRef.current = null;
        setOperation(null);
      }
    }
  }, [platform.runtime]);

  useEffect(() => {
    mountedRef.current = true;
    void navigateTo('/');
    return () => {
      mountedRef.current = false;
      requestRevisionRef.current += 1;
      operationRef.current = null;
      const gesture = gestureRef.current;
      if (gesture) releasePointerCapture(gesture);
      gestureRef.current = null;
    };
  }, [navigateTo]);

  useLayoutEffect(() => {
    setGeometry((current) => clampGeometry(current, viewportSize()));
    windowRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    const handleViewportResize = () => setGeometry((current) => clampGeometry(current, viewportSize()));
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, []);

  const applyGeometry = useCallback((next: WindowGeometry) => {
    const bounded = clampGeometry(next, viewportSize());
    setGeometry(bounded);
    return bounded;
  }, []);

  const beginPointerGesture = useCallback((event: PointerEvent<HTMLElement>, kind: PointerGesture['kind']) => {
    if (event.button !== 0 || gestureRef.current) return;
    if (kind === 'drag' && (event.target as Element | null)?.closest('button')) return;
    const target = event.currentTarget;
    gestureRef.current = {
      ...geometry,
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      target,
    };
    setPointerCapture(target, event.pointerId);
    event.preventDefault();
  }, [geometry]);

  const updatePointerGesture = useCallback((event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (gesture.kind === 'drag') {
      applyGeometry({ ...gesture, left: gesture.left + dx, top: gesture.top + dy });
    } else {
      applyGeometry(resizeGeometry(gesture, dx, dy, viewportSize()));
    }
    event.preventDefault();
  }, [applyGeometry]);

  const endPointerGesture = useCallback((event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    releasePointerCapture(gesture);
    gestureRef.current = null;
  }, []);

  const moveWithKeyboard = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if ((event.target as Element | null)?.closest('button')) return;
    const amount = event.shiftKey ? 50 : 10;
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') dx = -amount;
    else if (event.key === 'ArrowRight') dx = amount;
    else if (event.key === 'ArrowUp') dy = -amount;
    else if (event.key === 'ArrowDown') dy = amount;
    else return;
    setGeometry((current) => clampGeometry({ ...current, left: current.left + dx, top: current.top + dy }, viewportSize()));
    event.preventDefault();
  }, []);

  const resizeWithKeyboard = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    const amount = event.shiftKey ? 50 : 10;
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') dx = -amount;
    else if (event.key === 'ArrowRight') dx = amount;
    else if (event.key === 'ArrowUp') dy = -amount;
    else if (event.key === 'ArrowDown') dy = amount;
    else return;
    setGeometry((current) => resizeGeometry(current, dx, dy, viewportSize()));
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const activateEntry = useCallback(async (entry: FilesystemEntry | null) => {
    if (operationRef.current !== null) return;
    const directory = currentPathRef.current;
    if (entry === null) {
      if (directory !== '/') await navigateTo(parentPath(directory));
      return;
    }
    if (entry.isDirectory) {
      await navigateTo(childPath(directory, entry.name));
      return;
    }

    operationRef.current = { kind: 'downloading', fileName: entry.name };
    setOperation(operationRef.current);
    setError(null);
    setStatusMessage('');
    const revision = ++requestRevisionRef.current;
    try {
      const bytes = await platform.runtime.readFilesystemFile(childPath(directory, entry.name));
      if (!mountedRef.current || revision !== requestRevisionRef.current) return;
      await platform.downloads.download(entry.name, bytes);
    } catch (cause) {
      if (mountedRef.current && revision === requestRevisionRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current && revision === requestRevisionRef.current) {
        operationRef.current = null;
        setOperation(null);
      }
    }
  }, [navigateTo, platform.downloads, platform.runtime]);

  const handleWindowKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  if (typeof document === 'undefined') return null;
  const busy = operation !== null;
  const parentDisabled = path === '/' || busy;
  const status = operation?.kind === 'listing'
    ? `Loading ${operation.path}…`
    : operation?.kind === 'downloading'
      ? `Downloading ${operation.fileName}…`
      : statusMessage;

  return createPortal(
    <section
      ref={windowRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-label="File Manager"
      tabIndex={-1}
      data-testid="file-manager-window"
      className="fixed z-[100] flex min-w-0 flex-col overflow-hidden rounded-md border bg-card text-card-foreground shadow-2xl"
      style={geometry}
      onKeyDown={handleWindowKeyDown}
    >
      <header
        data-testid="file-manager-titlebar"
        aria-label="Move File Manager window"
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
        tabIndex={0}
        className="flex h-10 shrink-0 cursor-move select-none items-center justify-between gap-3 border-b px-3 text-xs font-semibold"
        style={{ touchAction: 'none' }}
        onPointerDown={(event) => beginPointerGesture(event, 'drag')}
        onPointerMove={updatePointerGesture}
        onPointerUp={endPointerGesture}
        onPointerCancel={endPointerGesture}
        onLostPointerCapture={endPointerGesture}
        onKeyDown={moveWithKeyboard}
      >
        <h2 id={titleId} className="min-w-0 flex-1 truncate" title={path}>
          File Manager <span aria-live="polite" data-testid="file-manager-path">{path}</span>
        </h2>
        <Button variant="ghost" size="xs" aria-label="Close File Manager" data-testid="file-manager-close" onClick={onClose}>
          <XIcon aria-hidden="true" className="pointer-events-none" />
        </Button>
      </header>
      <p className="sr-only" id={`${titleId}-instructions`}>
        Double-click a directory or file to open it. Focus a row and press Enter to open it. Press Escape to close this window.
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        <Table containerClassName="overflow-visible" className="border-collapse text-xs" aria-label="Filesystem entries" aria-describedby={`${titleId}-instructions`}>
          <TableHeader className="sticky top-0 bg-muted text-muted-foreground">
            <TableRow className="transition-none hover:bg-muted">
              <TableHead scope="col" className="h-auto px-3 py-2 text-left font-medium text-muted-foreground">Name</TableHead>
              <TableHead scope="col" className="h-auto w-28 px-3 py-2 text-right font-medium text-muted-foreground">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              data-testid="file-manager-parent"
              data-entry-name="../"
              aria-disabled={parentDisabled}
              tabIndex={parentDisabled ? -1 : 0}
              className={`border-t transition-none ${parentDisabled ? 'text-muted-foreground/60 hover:bg-transparent' : 'cursor-pointer hover:bg-muted/60'}`}
              onDoubleClick={() => { if (!parentDisabled) void activateEntry(null); }}
              onKeyDown={(event) => {
                if (!parentDisabled && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  void activateEntry(null);
                }
              }}
            >
              <TableCell className="px-3 py-1.5 font-mono whitespace-normal">../</TableCell>
              <TableCell className="px-3 py-1.5 text-right" />
            </TableRow>
            {entries.map((entry, index) => (
              <TableRow
                key={`${entry.name}:${index}`}
                data-testid={`file-manager-entry-${index}`}
                data-entry-name={entry.name}
                data-entry-type={entry.isDirectory ? 'directory' : 'file'}
                aria-disabled={busy}
                tabIndex={busy ? -1 : 0}
                className={`border-t transition-none ${busy ? 'text-muted-foreground/60 hover:bg-transparent' : 'cursor-pointer hover:bg-muted/60'}`}
                onDoubleClick={() => { if (!busy) void activateEntry(entry); }}
                onKeyDown={(event) => {
                  if (!busy && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    void activateEntry(entry);
                  }
                }}
              >
                <TableCell className="px-3 py-1.5 font-mono whitespace-normal">{entry.isDirectory ? `${entry.name}/` : entry.name}</TableCell>
                <TableCell className="px-3 py-1.5 text-right tabular-nums">{entry.isDirectory || entry.sizeBytes === null ? '' : `${entry.sizeBytes} B`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {error && <p role="alert" data-testid="file-manager-error" className="m-3 rounded-sm bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</p>}
      </div>
      <footer className="flex h-7 shrink-0 items-center justify-between gap-3 border-t px-3 text-[10px] text-muted-foreground">
        <span role="status" aria-live="polite" data-testid="file-manager-status">{status}</span>
        <span>{entries.length} {entries.length === 1 ? 'item' : 'items'}</span>
      </footer>
      <button
        type="button"
        data-testid="file-manager-resize"
        aria-label="Resize File Manager window"
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
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
    </section>,
    document.body,
  );
}
