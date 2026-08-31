import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceSliceCoordinator } from './sliceCoordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('Workspace slice coordinator', () => {
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
    await Promise.resolve();
    expect(slice).toHaveBeenCalledOnce();

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
    await Promise.resolve();
    const second = coordinator.ensureSlice();
    expect(slice).toHaveBeenCalledOnce();

    gate.resolve();
    await Promise.all([first, second]);
  });
});
