import { describe, expect, it, vi } from 'vitest';
import type { MenuStateSnapshot, PlatformCapabilities } from '@orca/platform-contract';
import { createCommandDispatcher, registerNativeMenuCommands, type CommandActions } from './commands';

function snapshot(enabled: Partial<Record<keyof MenuStateSnapshot['items'], boolean>> = {}): MenuStateSnapshot {
  const state = (command: keyof MenuStateSnapshot['items']) => ({
    enabled: enabled[command] ?? false,
    checked: false,
  });
  return {
    version: 1,
    boot: { phase: 'ready', error: null },
    slicer: { status: 'idle', progress: 0, error: null },
    scene: { hasModel: true },
    result: { hasResult: false, exported: false },
    host: { isElectron: true, menuMode: 'custom' },
    items: {
      'add-model': state('add-model'),
      'clear-scene': state('clear-scene'),
      slice: state('slice'),
      'export-gcode': state('export-gcode'),
      quit: state('quit'),
      'open-source': state('open-source'),
    },
  };
}

function actions(): CommandActions {
  return {
    addModel: vi.fn(async () => {}),
    clearScene: vi.fn(async () => {}),
    slice: vi.fn(async () => {}),
    exportGcode: vi.fn(async () => {}),
    openSource: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
  };
}

describe('shared menu command dispatcher', () => {
  it('rejects disabled and startup/slicing commands before invoking actions', async () => {
    const calls = actions();
    let current = snapshot({ 'add-model': false, slice: false });
    const dispatcher = createCommandDispatcher({ getSnapshot: () => current, actions: calls });

    await expect(dispatcher.dispatch('add-model')).resolves.toBe(false);
    await expect(dispatcher.dispatch('slice')).resolves.toBe(false);
    expect(calls.addModel).not.toHaveBeenCalled();
    expect(calls.slice).not.toHaveBeenCalled();

    current = snapshot({ 'add-model': true });
    const pending = dispatcher.dispatch('add-model');
    current = snapshot({ 'add-model': false });
    await expect(pending).resolves.toBe(true);
    expect(calls.addModel).toHaveBeenCalledTimes(1);
  });

  it('rechecks a stale command immediately before action selection', async () => {
    const calls = actions();
    let reads = 0;
    const dispatcher = createCommandDispatcher({
      getSnapshot: () => {
        reads += 1;
        return snapshot({ 'open-source': reads < 2 });
      },
      actions: calls,
    });

    await expect(dispatcher.dispatch('open-source')).resolves.toBe(false);
    expect(calls.openSource).not.toHaveBeenCalled();
  });

  it('routes native callbacks through the same guarded dispatcher', async () => {
    const calls = actions();
    let listener: ((command: 'open-source') => void) | undefined;
    const unsubscribe = vi.fn();
    const platform = {
      menu: {
        onCommand: (callback: (command: 'open-source') => void) => {
          listener = callback;
          return unsubscribe;
        },
      },
    } as unknown as Pick<PlatformCapabilities, 'menu'>;
    const dispatcher = createCommandDispatcher({
      getSnapshot: () => snapshot({ 'open-source': true }),
      actions: calls,
    });

    const cleanup = registerNativeMenuCommands(platform, dispatcher);
    listener?.('open-source');
    await Promise.resolve();

    expect(calls.openSource).toHaveBeenCalledTimes(1);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('routes source and quit to their injected host effects and resumes after a Strict Mode effect replay', async () => {
    const calls = actions();
    const dispatcher = createCommandDispatcher({
      getSnapshot: () => snapshot({ 'open-source': true, quit: true }),
      actions: calls,
    });

    await expect(dispatcher.dispatch('open-source')).resolves.toBe(true);
    await expect(dispatcher.dispatch('quit')).resolves.toBe(true);
    expect(calls.openSource).toHaveBeenCalledTimes(1);
    expect(calls.quit).toHaveBeenCalledTimes(1);

    dispatcher.dispose();
    await expect(dispatcher.dispatch('quit')).resolves.toBe(false);

    dispatcher.activate();
    await expect(dispatcher.dispatch('quit')).resolves.toBe(true);
    expect(calls.quit).toHaveBeenCalledTimes(2);
  });
});
