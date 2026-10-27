// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SliceNotifications } from './SliceNotifications';
import { useNotificationStore as notifications } from '@/stores/useNotificationStore';
import { usePlateSessionStore as plates } from '@/stores/usePlateSessionStore';
import type { PlateSessionSnapshot } from '@slicer/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const snapshot = (currentPlateId = 'a', revision = 1): PlateSessionSnapshot => ({
  ok: true, version: 1, currentPlateId, inputRevisions: { a: revision, b: 1 },
  instances: [{ instanceId: 1, objectId: 42, objectIndex: 0, instanceIndex: 0, plateId: 'a', member: true, unprintable: false, outOfBounds: false }],
  plates: ['a', 'b'].map((plateId, displayIndex) => ({ plateId, displayIndex, name: plateId, origin: [0, 0, 0] })),
});

describe('slice notification presentation', () => {
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    notifications.getState().reset(); plates.getState().setSnapshot(snapshot());
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById('root')!);
  });
  afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('keeps full diagnostics indefinitely, acknowledges explicit close and preserves other cards', async () => {
    const token = notifications.getState().begin({ plateId: 'a', inputRevision: 1 });
    notifications.getState().receive(token, { taskId: '1', plateId: 'a', inputRevision: 1, phase: 'validation', diagnostics: [
      { key: 'one', severity: 'warning', message: 'Long native warning '.repeat(60), objectIds: ['42'] },
      { key: 'two', severity: 'error', message: 'Blocking error', objectIds: [] },
      ...Array.from({ length: 4 }, (_, index) => ({ key: `extra:${index}`, severity: 'warning' as const,
        message: `Additional warning ${index}`, objectIds: [] })),
    ] });
    await act(async () => root.render(<SliceNotifications />));
    expect(document.querySelectorAll('[data-testid="slice-notification"]')).toHaveLength(6);
    expect(document.querySelectorAll('[data-slot="toast"][data-limited]')).toHaveLength(0);
    expect(document.querySelector('[data-testid="slice-notification"]')?.textContent).toContain('Blocking error');
    expect(document.body.textContent).toContain('Long native warning '.repeat(60));
    vi.useFakeTimers();
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(document.querySelectorAll('[data-testid="slice-notification"]')).toHaveLength(6);
    await act(async () => { (document.querySelector('[data-slot="toast-close"]') as HTMLButtonElement).click(); });
    expect(document.querySelectorAll('[data-testid="slice-notification"]')).toHaveLength(5);
    expect(notifications.getState().notifications.find(n => n.message === 'Blocking error')?.dismissed).toBe(true);
  });

  it('hides other plates without dismissing their cards and updates stale/deleted source state', async () => {
    const token = notifications.getState().begin({ plateId: 'a', inputRevision: 1 });
    notifications.getState().receive(token, { taskId: '1', plateId: 'a', inputRevision: 1, phase: 'validation', diagnostics: [
      { key: 'one', severity: 'warning', message: 'Object warning', objectIds: ['42'] },
    ] });
    await act(async () => root.render(<SliceNotifications />));
    await act(async () => plates.getState().setSnapshot(snapshot('b')));
    expect(document.querySelectorAll('[data-testid="slice-notification"]')).toHaveLength(0);
    expect(notifications.getState().notifications[0].dismissed).toBe(false);
    await act(async () => plates.getState().setSnapshot(snapshot('a', 2)));
    expect(document.querySelector('[data-testid="slice-notification"]')?.textContent).toContain('Awaiting revalidation');
    await act(async () => plates.getState().setSnapshot({ ...snapshot('a', 3), instances: [] }));
    expect(document.querySelectorAll('[data-testid="slice-notification"]')).toHaveLength(0);
  });
});
