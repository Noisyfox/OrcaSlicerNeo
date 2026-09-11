import type { HistoryStatus } from '@slicer/client';

export type HistoryNavigationDirection = 'undo' | 'redo';

/**
 * Worker history is the only source of truth for navigation.  Context records
 * are retained by the Worker so a project restore can recover selection and
 * plate state, but they are not user-visible operations in these menus.
 */
export function projectHistoryEntries(
  status: HistoryStatus | null | undefined,
  direction: HistoryNavigationDirection,
) {
  return (direction === 'undo' ? status?.undoEntries : status?.redoEntries)
    ?.filter((entry) => entry.category === 'project') ?? [];
}

export function historyNextOperationLabel(
  status: HistoryStatus | null | undefined,
  direction: HistoryNavigationDirection,
): string {
  const label = direction === 'undo' ? status?.undoLabel : status?.redoLabel;
  return label ? `${direction === 'undo' ? 'Undo' : 'Redo'} ${label}` : direction === 'undo' ? 'Undo' : 'Redo';
}

/**
 * A displayed HistoryStatus is a projection, so it cannot reject a navigation
 * intent while another restore is advancing the native cursor.  The Worker
 * decides availability for those queued intents at the FIFO head.
 */
export function historyNavigationIntentAllowed(
  status: HistoryStatus | null | undefined,
  direction: HistoryNavigationDirection,
  restoring: boolean,
): boolean {
  if (!status || status.disabled || status.activeTransactionId !== null) return false;
  if (restoring) return true;
  return direction === 'undo' ? status.canUndo : status.canRedo;
}

export function historyNavigationDisabled(
  status: HistoryStatus | null | undefined,
  direction: HistoryNavigationDirection,
  restoring: boolean,
  hasCoordinator: boolean,
): boolean {
  return !hasCoordinator || !historyNavigationIntentAllowed(status, direction, restoring);
}

/** Native text editing owns its own Ctrl/Cmd+Z/Y semantics. */
export function isEditableHistoryTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(
    'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
  );
}

export function historyShortcutAction(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): HistoryNavigationDirection | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !event.metaKey && !event.shiftKey) return 'redo';
  return null;
}
