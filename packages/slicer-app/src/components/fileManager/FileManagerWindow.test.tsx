// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesystemEntry } from '@slicer/client';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { FileManagerWindow } from './FileManagerWindow';

function testPlatform() {
  const runtime = {
    listFilesystemDirectory: vi.fn(async (_path: string): Promise<FilesystemEntry[]> => []),
    readFilesystemFile: vi.fn(async (_path: string): Promise<Uint8Array> => new Uint8Array()),
  };
  const downloads = { download: vi.fn(async (_name: string, _bytes: Uint8Array) => undefined) };
  return { platform: { runtime, downloads } as unknown as PlatformCapabilities, runtime, downloads };
}

async function mount(platform: PlatformCapabilities, onClose = vi.fn()) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PlatformProvider value={platform}><FileManagerWindow focusRequest={1} onClose={onClose} /></PlatformProvider>);
  });
  return { root, container, onClose };
}

async function doubleClick(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ pointerId, clientX, clientY, button: 0 })) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

describe('FileManagerWindow', () => {
  let root: Root | undefined;
  let innerWidthDescriptor: PropertyDescriptor | undefined;
  let innerHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    document.body.innerHTML = '';
    if (innerWidthDescriptor) Object.defineProperty(window, 'innerWidth', innerWidthDescriptor);
    else Reflect.deleteProperty(window, 'innerWidth');
    if (innerHeightDescriptor) Object.defineProperty(window, 'innerHeight', innerHeightDescriptor);
    else Reflect.deleteProperty(window, 'innerHeight');
    vi.restoreAllMocks();
  });

  it('lists the root parent first, navigates directories, and downloads exact names and bytes', async () => {
    const { platform, runtime, downloads } = testPlatform();
    const fileBytes = Uint8Array.from([0, 17, 255]);
    runtime.listFilesystemDirectory.mockImplementation(async (path) => path === '/'
      ? [
        { name: 'tmp', isDirectory: true, sizeBytes: null },
        { name: 'no-extension', isDirectory: false, sizeBytes: 3 },
      ]
      : [{ name: 'payload.anything', isDirectory: false, sizeBytes: 3 }]);
    runtime.readFilesystemFile.mockResolvedValue(fileBytes);

    const mounted = await mount(platform);
    root = mounted.root;
    const rows = [...document.querySelectorAll('[data-testid^="file-manager-entry-"]')];
    expect(document.querySelector('table[data-slot="table"]')).not.toBeNull();
    const tableContainer = document.querySelector('[data-slot="table-container"]');
    expect(tableContainer?.classList.contains('overflow-visible')).toBe(true);
    expect(tableContainer?.classList.contains('overflow-x-auto')).toBe(false);
    expect(document.querySelector('thead[data-slot="table-header"]')).not.toBeNull();
    expect(document.querySelector('thead[data-slot="table-header"]')?.classList.contains('sticky')).toBe(true);
    const parentRow = document.querySelector<HTMLElement>('tbody tr:first-child');
    expect(parentRow?.getAttribute('data-testid')).toBe('file-manager-parent');
    expect(parentRow?.getAttribute('aria-disabled')).toBe('true');
    expect(parentRow?.classList.contains('hover:bg-transparent')).toBe(true);
    expect(parentRow?.classList.contains('hover:bg-muted/50')).toBe(false);
    expect([...document.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Name', 'Size']);
    expect(rows.map((row) => row.textContent)).toEqual(['tmp/', 'no-extension3 B']);
    expect(rows[0]?.getAttribute('data-entry-type')).toBe('directory');

    await doubleClick(rows[0]!);
    expect(runtime.listFilesystemDirectory).toHaveBeenLastCalledWith('/tmp');
    expect(document.querySelector('[data-testid="file-manager-path"]')?.textContent).toBe('/tmp');
    expect(document.querySelector('[data-testid="file-manager-parent"]')?.getAttribute('aria-disabled')).toBe('false');
    const file = document.querySelector('[data-testid="file-manager-entry-0"]')!;
    expect(file.textContent).toBe('payload.anything3 B');

    await doubleClick(file);
    expect(runtime.readFilesystemFile).toHaveBeenCalledWith('/tmp/payload.anything');
    expect(downloads.download).toHaveBeenCalledWith('payload.anything', fileBytes);
    expect(document.querySelector('[data-testid="file-manager-path"]')?.textContent).toBe('/tmp');
  });

  it('keeps the current path and listing visible when navigation or download fails', async () => {
    const { platform, runtime, downloads } = testPlatform();
    runtime.listFilesystemDirectory.mockImplementation(async (path) => {
      if (path === '/blocked') throw new Error('permission denied');
      return [
        { name: 'blocked', isDirectory: true, sizeBytes: null },
        { name: 'broken.bin', isDirectory: false, sizeBytes: 1 },
      ];
    });
    runtime.readFilesystemFile.mockResolvedValue(Uint8Array.of(5));
    downloads.download.mockRejectedValue(new Error('save failed'));

    const mounted = await mount(platform);
    root = mounted.root;
    await doubleClick(document.querySelector('[data-testid="file-manager-entry-0"]')!);
    expect(document.querySelector('[data-testid="file-manager-path"]')?.textContent).toBe('/');
    expect(document.querySelector('[data-testid="file-manager-error"]')?.textContent).toBe('permission denied');
    expect(document.querySelectorAll('[data-testid^="file-manager-entry-"]')).toHaveLength(2);

    await doubleClick(document.querySelector('[data-testid="file-manager-entry-1"]')!);
    expect(document.querySelector('[data-testid="file-manager-path"]')?.textContent).toBe('/');
    expect(document.querySelector('[data-testid="file-manager-error"]')?.textContent).toBe('save failed');
    expect(downloads.download).toHaveBeenCalledWith('broken.bin', Uint8Array.of(5));
  });

  it('removes default Table hover styling from entry rows while an operation is busy', async () => {
    const { platform, runtime } = testPlatform();
    runtime.listFilesystemDirectory.mockResolvedValue([
      { name: 'busy.bin', isDirectory: false, sizeBytes: 1 },
    ]);
    let resolveRead!: (bytes: Uint8Array) => void;
    runtime.readFilesystemFile.mockImplementation(() => new Promise<Uint8Array>((resolve) => {
      resolveRead = resolve;
    }));

    const mounted = await mount(platform);
    root = mounted.root;
    const fileRow = document.querySelector<HTMLElement>('[data-testid="file-manager-entry-0"]')!;
    await doubleClick(fileRow);

    expect(fileRow.getAttribute('aria-disabled')).toBe('true');
    expect(fileRow.classList.contains('hover:bg-transparent')).toBe(true);
    expect(fileRow.classList.contains('hover:bg-muted/50')).toBe(false);

    await act(async () => {
      resolveRead(Uint8Array.of(1));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('ignores a stale Worker listing reply after an effect replay', async () => {
    const { platform, runtime } = testPlatform();
    let resolveFirst!: (entries: FilesystemEntry[]) => void;
    let resolveSecond!: (entries: FilesystemEntry[]) => void;
    runtime.listFilesystemDirectory
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<StrictMode><PlatformProvider value={platform}><FileManagerWindow focusRequest={1} onClose={vi.fn()} /></PlatformProvider></StrictMode>);
    });
    expect(runtime.listFilesystemDirectory).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond([{ name: 'current', isDirectory: false, sizeBytes: 2 }]);
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst([{ name: 'stale', isDirectory: false, sizeBytes: 1 }]);
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="file-manager-entry-0"]')?.getAttribute('data-entry-name')).toBe('current');
  });

  it('supports keyboard movement and resizing, pointer dragging, and viewport containment', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const { platform } = testPlatform();
    const mounted = await mount(platform);
    root = mounted.root;
    const manager = document.querySelector<HTMLElement>('[data-testid="file-manager-window"]')!;
    const titlebar = document.querySelector<HTMLElement>('[data-testid="file-manager-titlebar"]')!;
    const resize = document.querySelector<HTMLButtonElement>('[data-testid="file-manager-resize"]')!;

    await act(async () => {
      titlebar.focus();
      titlebar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(manager.style.left).toBe('34px');

    await act(async () => {
      resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(manager.style.width).toBe('610px');

    await act(async () => {
      titlebar.dispatchEvent(pointerEvent('pointerdown', 1, 40, 50));
      titlebar.dispatchEvent(pointerEvent('pointermove', 1, 2040, 2050));
      titlebar.dispatchEvent(pointerEvent('pointerup', 1, 2040, 2050));
    });
    expect(parseFloat(manager.style.left) + parseFloat(manager.style.width)).toBeLessThanOrEqual(800);
    expect(parseFloat(manager.style.top) + parseFloat(manager.style.height)).toBeLessThanOrEqual(600);
  });
});
