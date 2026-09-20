import { describe, expect, it, vi } from 'vitest';
import { handleMenuKeyDown } from '../App';
import { createCommandDispatcher, type CommandActions } from './commands';
import type { MenuStateSnapshot } from '@orca/platform-contract';

function snapshot(command: keyof MenuStateSnapshot['items'], enabled: boolean): MenuStateSnapshot {
  const items = Object.fromEntries([
    'new-project', 'open-project', 'save-project', 'save-project-as', 'preferences',
    'add-model', 'clear-scene', 'slice', 'export-gcode', 'quit', 'open-source',
  ].map((id) => [id, { enabled: id === command ? enabled : false, checked: false }])) as MenuStateSnapshot['items'];
  return {
    version: 1,
    activeTab: 'prepare',
    boot: { phase: 'ready', error: null },
    slicer: { status: 'idle', progress: 0, error: null },
    scene: { hasModel: true },
    result: { hasResult: false, exported: false },
    project: { hasContent: true, dirty: true, operation: { phase: 'idle', progress: 0, cancellable: false } },
    host: { isElectron: false, menuMode: 'browser' },
    items,
  };
}

function actions(): CommandActions {
  return {
    newProject: vi.fn(async () => {}),
    openProject: vi.fn(async () => {}),
    saveProject: vi.fn(async () => {}),
    saveProjectAs: vi.fn(async () => {}),
    preferences: vi.fn(async () => {}),
    addModel: vi.fn(async () => {}),
    clearScene: vi.fn(async () => {}),
    slice: vi.fn(async () => {}),
    exportGcode: vi.fn(async () => {}),
    openSource: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
  };
}

describe('shared project keyboard shortcuts', () => {
  it.each([
    ['n', 'new-project', 'newProject'],
    ['o', 'open-project', 'openProject'],
    ['s', 'save-project', 'saveProject'],
    ['s', 'save-project-as', 'saveProjectAs'],
  ] as const)('prevents the Web default and routes Ctrl/Cmd+%s through the guarded dispatcher', async (key, command, action) => {
    const calls = actions();
    const dispatcher = createCommandDispatcher({ getSnapshot: () => snapshot(command, true), actions: calls });
    const preventDefault = vi.fn();
    const event = { key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: command === 'save-project-as', preventDefault };
    expect(handleMenuKeyDown(event, dispatcher)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(calls[action]).toHaveBeenCalledOnce();
  });

  it('still blocks the browser default for a disabled shortcut while the dispatcher rejects it', async () => {
    const calls = actions();
    const dispatcher = createCommandDispatcher({ getSnapshot: () => snapshot('save-project', false), actions: calls });
    const preventDefault = vi.fn();
    expect(handleMenuKeyDown({ key: 's', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, preventDefault }, dispatcher)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(calls.saveProject).not.toHaveBeenCalled();
  });
});
