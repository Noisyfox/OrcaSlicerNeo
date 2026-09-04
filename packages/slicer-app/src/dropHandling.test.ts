// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { externalDropFiles, isThreeMfDropFile, registerProjectDropHandlers } from './dropHandling';

describe('project drag/drop filtering', () => {
  it('accepts a desktop 3MF extension even when the MIME type is generic', () => {
    expect(isThreeMfDropFile({ name: 'Scene.3MF', type: 'application/octet-stream' })).toBe(true);
  });

  it('accepts the known 3MF MIME type when the drag source omits a useful extension', () => {
    expect(isThreeMfDropFile({ name: 'download', type: 'model/3mf' })).toBe(true);
  });

  it('does not classify model files as project drops', () => {
    expect(isThreeMfDropFile({ name: 'cube.stl', type: 'model/stl' })).toBe(false);
  });

  it('extracts only external files and leaves text-only application drags alone', () => {
    const file = { name: 'scene.3mf', type: '', arrayBuffer: async () => new ArrayBuffer(0) } as File;
    expect(externalDropFiles({ files: [file] } as unknown as DataTransfer)).toEqual([file]);
    expect(externalDropFiles({ files: [] } as unknown as DataTransfer)).toEqual([]);
  });

  it('captures a 3MF drop before a nested target stops propagation and invokes the shared callback', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    target.addEventListener('drop', (event) => event.stopPropagation());
    const file = new File([new Uint8Array([80, 75])], 'scene.3mf', { type: 'application/octet-stream' });
    let resolveFiles!: (files: File[]) => void;
    const opened = new Promise<File[]>((resolve) => { resolveFiles = resolve; });
    const openDropped = vi.fn(async (files: File[]) => { resolveFiles(files); });
    const cleanup = registerProjectDropHandlers(document, (files) => openDropped(files));
    try {
      const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
      target.dispatchEvent(event);
      await expect(opened).resolves.toEqual([file]);
      expect(openDropped).toHaveBeenCalledWith([file]);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      cleanup();
      target.remove();
    }
  });

  it('prevents navigation for non-3MF files without entering the project callback', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const opened = vi.fn();
    const cleanup = registerProjectDropHandlers(document, opened);
    try {
      const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['solid'], 'cube.stl', { type: 'model/stl' })] } });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      cleanup();
      target.remove();
    }
  });

  it('leaves text-only internal drags available to their existing target handlers', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const opened = vi.fn();
    const cleanup = registerProjectDropHandlers(document, opened);
    try {
      const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { files: [] } });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      cleanup();
      target.remove();
    }
  });
});
