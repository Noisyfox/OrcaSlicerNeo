// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { externalDropFiles, hasExternalFileDrag, isModelDropFile, isThreeMfDropFile, registerProjectDropHandlers } from './dropHandling';

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

  it.each(['stl', 'drc', 'step', 'stp'])('classifies .%s as a model drop', (extension) => {
    expect(isModelDropFile({ name: `cube.${extension}`, type: 'application/octet-stream' })).toBe(true);
  });

  it('keeps 3MF on the project route instead of the model route', () => {
    expect(isModelDropFile({ name: 'scene.3mf', type: 'model/3mf' })).toBe(false);
  });

  it('extracts only external files and leaves text-only application drags alone', () => {
    const file = { name: 'scene.3mf', type: '', arrayBuffer: async () => new ArrayBuffer(0) } as File;
    expect(externalDropFiles({ files: [file] } as unknown as DataTransfer)).toEqual([file]);
    expect(externalDropFiles({ files: [] } as unknown as DataTransfer)).toEqual([]);
  });

  it('falls back to file data-transfer items when Chromium leaves files empty', () => {
    const file = new File([new Uint8Array([80, 75])], 'scene.3mf');
    const dataTransfer = {
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => file },
      ],
    } as unknown as DataTransfer;
    expect(hasExternalFileDrag(dataTransfer)).toBe(true);
    expect(externalDropFiles(dataTransfer)).toEqual([file]);
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

  it('routes supported model drops to Add Model before nested targets can stop propagation', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    target.addEventListener('drop', (event) => event.stopPropagation());
    const file = new File([new Uint8Array([1, 2])], 'cube.step');
    const projectDrop = vi.fn();
    const modelDrop = vi.fn(async () => undefined);
    const cleanup = registerProjectDropHandlers(document, { onProjectDrop: projectDrop, onModelDrop: modelDrop });
    try {
      const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
      target.dispatchEvent(event);
      await vi.waitFor(() => expect(modelDrop).toHaveBeenCalledWith([file]));
      expect(projectDrop).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      cleanup();
      target.remove();
    }
  });

  it('routes a dropped 3MF only to the existing project flow', async () => {
    const file = new File([new Uint8Array([80, 75])], 'scene.3mf');
    const projectDrop = vi.fn(async () => undefined);
    const modelDrop = vi.fn();
    const cleanup = registerProjectDropHandlers(document, { onProjectDrop: projectDrop, onModelDrop: modelDrop });
    try {
      const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
      document.dispatchEvent(event);
      await vi.waitFor(() => expect(projectDrop).toHaveBeenCalledWith([file]));
      expect(modelDrop).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('leaves unsupported external files and text-only drops out of both routes', () => {
    const projectDrop = vi.fn();
    const modelDrop = vi.fn();
    const cleanup = registerProjectDropHandlers(document, { onProjectDrop: projectDrop, onModelDrop: modelDrop });
    try {
      const unsupported = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(unsupported, 'dataTransfer', { value: { files: [new File(['x'], 'notes.txt')] } });
      document.dispatchEvent(unsupported);
      expect(unsupported.defaultPrevented).toBe(true);
      expect(projectDrop).not.toHaveBeenCalled();
      expect(modelDrop).not.toHaveBeenCalled();
      const textOnly = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(textOnly, 'dataTransfer', { value: { files: [] } });
      document.dispatchEvent(textOnly);
      expect(textOnly.defaultPrevented).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('accepts an OS file drag when dragover exposes only DataTransfer.items', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const cleanup = registerProjectDropHandlers(document, vi.fn<(files: File[]) => void>());
    try {
      const event = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', {
        value: { files: [], items: [{ kind: 'file', getAsFile: () => null }] },
      });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
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
