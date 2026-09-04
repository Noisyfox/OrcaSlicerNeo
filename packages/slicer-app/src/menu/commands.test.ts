import { describe, expect, it, vi } from 'vitest';
import type { MenuStateSnapshot, PlatformCapabilities } from '@orca/platform-contract';
import { createCommandDispatcher, registerNativeMenuCommands, type CommandActions } from './commands';

function snapshot(enabled: Partial<Record<keyof MenuStateSnapshot['items'], boolean>> = {}): MenuStateSnapshot {
  const state = (command: keyof MenuStateSnapshot['items']) => ({
    enabled: enabled[command] ?? false,
    checked: false,
  });
  const items = {
    'add-model': state('add-model'),
    'clear-scene': state('clear-scene'),
    slice: state('slice'),
    'export-gcode': state('export-gcode'),
    quit: state('quit'),
    'open-source': state('open-source'),
    'new-project': state('new-project'),
    'open-project': state('open-project'),
    'save-project': state('save-project'),
    'save-project-as': state('save-project-as'),
    preferences: state('preferences'),
  };
  return {
    version: 1,
    activeTab: 'prepare',
    boot: { phase: 'ready', error: null },
    slicer: { status: 'idle', progress: 0, error: null },
    scene: { hasModel: true },
    result: { hasResult: false, exported: false },
    host: { isElectron: true, menuMode: 'custom' },
    items,
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

  it.each(['home', 'preview', 'device'] as const)('rejects model mutations and slice commands outside Prepare/Preview policy on %s', async (activeTab) => {
    const calls = actions();
    const base = snapshot({ 'add-model': true, 'clear-scene': true, slice: true });
    const current = {
      ...base,
      activeTab,
      items: {
        ...base.items,
        'add-model': { enabled: false },
        'clear-scene': { enabled: false },
        slice: { enabled: activeTab === 'preview' },
      },
    };
    const dispatcher = createCommandDispatcher({ getSnapshot: () => current, actions: calls });

    await expect(dispatcher.dispatch('add-model')).resolves.toBe(false);
    await expect(dispatcher.dispatch('clear-scene')).resolves.toBe(false);
    if (activeTab !== 'preview') await expect(dispatcher.dispatch('slice')).resolves.toBe(false);
    expect(calls.addModel).not.toHaveBeenCalled();
    expect(calls.clearScene).not.toHaveBeenCalled();
    if (activeTab !== 'preview') expect(calls.slice).not.toHaveBeenCalled();
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

  it('routes project commands through the same guarded dispatcher', async () => {
    const calls = {
      ...actions(),
      newProject: vi.fn(async () => {}),
      openProject: vi.fn(async () => {}),
      saveProject: vi.fn(async () => {}),
      saveProjectAs: vi.fn(async () => {}),
      preferences: vi.fn(async () => {}),
    };
    const dispatcher = createCommandDispatcher({
      getSnapshot: () => snapshot({
        'new-project': true, 'open-project': true,
        'save-project': true, 'save-project-as': true, preferences: true,
      }),
      actions: calls,
    });
    for (const command of ['new-project', 'open-project', 'save-project', 'save-project-as', 'preferences'] as const) {
      await expect(dispatcher.dispatch(command)).resolves.toBe(true);
    }
    expect(calls.newProject).toHaveBeenCalledOnce();
    expect(calls.openProject).toHaveBeenCalledOnce();
    expect(calls.saveProject).toHaveBeenCalledOnce();
    expect(calls.saveProjectAs).toHaveBeenCalledOnce();
    expect(calls.preferences).toHaveBeenCalledOnce();
  });
});
