import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceSliceCoordinator } from './sliceCoordinator';
import { registerMeasureCommands } from './viewport/gizmo/measure/projectCommands';
import type { MeasureController } from './viewport/gizmo/measure/MeasureController';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('Workspace slice coordinator', () => {
  it('opens Preview immediately but waits for Measure cleanup before slicing', async () => {
    const events: string[] = []; const gate = deferred();
    let active = true;
    const owner = { get active() { return active; },
      close: vi.fn(() => { active = false; events.push('close'); return gate.promise; }),
      settled: () => gate.promise } as unknown as MeasureController;
    const unregister = registerMeasureCommands(owner);
    try {
      const coordinator = createWorkspaceSliceCoordinator({ isModelLoaded: () => true, getStatus: () => 'idle',
        slice: async () => { events.push('slice'); }, requestPreview: () => { events.push('preview'); } });
      const task = coordinator.requestPreviewSlice();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(events).toEqual(['close', 'preview']); gate.resolve(); await task;
      expect(events).toEqual(['close', 'preview', 'slice']);
    } finally { unregister(); }
  });

  it('waits for already queued Measure cleanup before starting an automatic Preview slice', async () => {
    const gate = deferred();
    const owner = { active: false, settled: () => gate.promise } as unknown as MeasureController;
    const unregister = registerMeasureCommands(owner);
    try {
      const slice = vi.fn(async () => undefined);
      const coordinator = createWorkspaceSliceCoordinator({ isModelLoaded: () => true, getStatus: () => 'idle',
        slice, requestPreview: vi.fn() });
      const task = coordinator.ensureSlice();
      await Promise.resolve();
      expect(slice).not.toHaveBeenCalled();
      gate.resolve(); await task;
      expect(slice).toHaveBeenCalledOnce();
    } finally { unregister(); }
  });

  it('opens Preview during an existing slice without waiting for Measure cleanup', async () => {
    const gate = deferred();
    const events: string[] = [];
    const owner = { active: true, close: () => { events.push('close'); return gate.promise; } } as unknown as MeasureController;
    const unregister = registerMeasureCommands(owner);
    try {
      const slice = vi.fn(async () => undefined);
      const coordinator = createWorkspaceSliceCoordinator({ isModelLoaded: () => true, getStatus: () => 'slicing',
        slice, requestPreview: () => { events.push('preview'); } });
      const task = coordinator.requestPreviewSlice();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(events).toEqual(['close', 'preview']);
      expect(slice).not.toHaveBeenCalled();
      gate.resolve(); await task;
      expect(slice).not.toHaveBeenCalled();
    } finally { unregister(); }
  });
  it('starts a slice when entering Preview and navigates first', async () => {
    const events: string[] = [];
    const slice = vi.fn(async () => { events.push('slice'); });
    const coordinator = createWorkspaceSliceCoordinator({
      isModelLoaded: () => true,
      getStatus: () => 'idle',
      slice,
      requestPreview: () => events.push('preview'),
    });

    await coordinator.requestPreviewSlice();

    expect(events).toEqual(['preview', 'slice']);
    expect(slice).toHaveBeenCalledOnce();
  });

  it('does not slice when a valid result already exists', async () => {
    const slice = vi.fn(async () => undefined);
    const coordinator = createWorkspaceSliceCoordinator({
      isModelLoaded: () => true,
      getStatus: () => 'done',
      slice,
      requestPreview: vi.fn(),
    });

    await coordinator.ensureSlice();

    expect(slice).not.toHaveBeenCalled();
  });

  it('joins concurrent requests before the slice status is published', async () => {
    const gate = deferred();
    const slice = vi.fn(() => gate.promise);
    const coordinator = createWorkspaceSliceCoordinator({
      isModelLoaded: () => true,
      getStatus: () => 'idle',
      slice,
      requestPreview: vi.fn(),
    });

    const first = coordinator.ensureSlice();
    const second = coordinator.ensureSlice();
    expect(slice).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());

    gate.resolve();
    await Promise.all([first, second]);
  });

  it('does not slice without a loaded model', async () => {
    const slice = vi.fn(async () => undefined);
    const coordinator = createWorkspaceSliceCoordinator({
      isModelLoaded: () => false,
      getStatus: () => 'idle',
      slice,
      requestPreview: vi.fn(),
    });

    await coordinator.ensureSlice();

    expect(slice).not.toHaveBeenCalled();
  });

  it('joins an already slicing task without starting another one', async () => {
    const gate = deferred();
    const slice = vi.fn(() => gate.promise);
    let status: 'idle' | 'slicing' = 'idle';
    const coordinator = createWorkspaceSliceCoordinator({
      isModelLoaded: () => true,
      getStatus: () => status,
      slice: async () => { status = 'slicing'; await slice(); },
      requestPreview: vi.fn(),
    });

    const first = coordinator.ensureSlice();
    await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());
    const second = coordinator.ensureSlice();
    expect(slice).toHaveBeenCalledOnce();

    gate.resolve();
    await Promise.all([first, second]);
  });
});
