// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HistoryStatus } from '@slicer/client';
import {
  historyNavigationDisabled,
  historyNextOperationLabel,
  historyShortcutAction,
  isEditableHistoryTarget,
  projectHistoryEntries,
} from './historyNavigation';

const status: HistoryStatus = {
  canUndo: true,
  canRedo: true,
  undoLabel: 'Move',
  redoLabel: 'Delete',
  undoEntries: [
    { id: 'u-context', label: 'Selection', category: 'context' },
    { id: 'u-project', label: 'Move', category: 'project' },
  ],
  redoEntries: [
    { id: 'r-project', label: 'Add Model', category: 'project' },
    { id: 'r-context', label: 'Active Plate', category: 'context' },
  ],
  cursor: 2,
  savedCheckpoint: 0,
  savedCheckpointEvicted: false,
  dirty: true,
  bytesUsed: 10,
  byteBudget: 100,
  optionalBytesReleased: 0, evictedEntryCount: 0, lastEvictedEntryId: null,
  oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
  disabled: false,
  activeTransactionId: null,
  revision: 2,
};

describe('shared history navigation semantics', () => {
  it('shows only Worker project entries while retaining Worker order', () => {
    expect(projectHistoryEntries(status, 'undo')).toEqual([
      { id: 'u-project', label: 'Move', category: 'project' },
    ]);
    expect(projectHistoryEntries(status, 'redo')).toEqual([
      { id: 'r-project', label: 'Add Model', category: 'project' },
    ]);
  });

  it('labels the next operation and disables navigation only from Worker state', () => {
    expect(historyNextOperationLabel(status, 'undo')).toBe('Undo Move');
    expect(historyNextOperationLabel(status, 'redo')).toBe('Redo Delete');
    expect(historyNavigationDisabled(status, 'undo', false, true)).toBe(false);
    expect(historyNavigationDisabled(status, 'undo', true, true)).toBe(true);
    expect(historyNavigationDisabled({ ...status, disabled: true }, 'undo', false, true)).toBe(true);
    expect(historyNavigationDisabled({ ...status, activeTransactionId: 'tx-1' }, 'undo', false, true)).toBe(true);
    expect(historyNavigationDisabled(null, 'redo', false, true)).toBe(true);
  });

  it('leaves native editable controls alone', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    document.body.append(input, button);
    expect(isEditableHistoryTarget(input)).toBe(true);
    expect(isEditableHistoryTarget(button)).toBe(false);
  });

  it('maps the shared shortcut set, while Cmd+Y remains native on macOS', () => {
    expect(historyShortcutAction({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('undo');
    expect(historyShortcutAction({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe('redo');
    expect(historyShortcutAction({ key: 'y', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('redo');
    expect(historyShortcutAction({ key: 'y', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBeNull();
  });
});
