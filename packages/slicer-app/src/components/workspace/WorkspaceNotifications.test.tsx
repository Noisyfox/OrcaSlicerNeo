// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceNotifications } from './WorkspaceNotifications';
import { useNotificationStore as notifications } from '@/stores/useNotificationStore';
import { usePlateSessionStore as plates } from '@/stores/usePlateSessionStore';
import type { PlateSessionSnapshot } from '@slicer/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const snapshot = (currentPlateId = 'a', revision = 1): PlateSessionSnapshot => ({
  ok: true, version: 1, currentPlateId, inputRevisions: { a: revision, b: 1 },
  instances: [{ instanceId: 1, objectId: 42, objectIndex: 0, instanceIndex: 0, plateId: 'a', member: true, unprintable: false, outOfBounds: false }],
  plates: ['a', 'b'].map((plateId, displayIndex) => ({ plateId, displayIndex, name: plateId, origin: [0, 0, 0] })),
});

describe('workspace notification presentation', () => {
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
    await act(async () => root.render(<WorkspaceNotifications />));
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
    await act(async () => root.render(<WorkspaceNotifications />));
    await act(async () => plates.getState().setSnapshot(snapshot('b')));
    expect(document.querySelectorAll('[data-testid="slice-notification"]')).toHaveLength(0);
    expect(notifications.getState().notifications[0].dismissed).toBe(false);
    await act(async () => plates.getState().setSnapshot(snapshot('a', 2)));
    expect(document.querySelector('[data-testid="slice-notification"]')?.textContent).toContain('Awaiting revalidation');
    await act(async () => plates.getState().setSnapshot({ ...snapshot('a', 3), instances: [] }));
    expect(document.querySelectorAll('[data-testid="slice-notification"]')).toHaveLength(0);
  });

  it('renders caller-supplied progress, actions and dismissal policy outside disabled controls', async () => {
    const token = notifications.getState().beginOperation({ key: 'transfer', plateId: 'a', title: 'Uploading models',
      message: 'Sending model 2', severity: 'info', progress: { value: 42, label: 'Upload progress' }, dismissible: false });
    const details = vi.fn();
    const cancel = vi.fn(() => notifications.getState().updateOperation(token, { message: 'Stopping transfer…', actions: [
      { id: 'stop', label: 'Stopping…', disabled: true, onClick: cancel },
    ] }));
    notifications.getState().updateOperation(token, { actions: [
      { id: 'stop', label: 'Stop transfer', onClick: cancel }, { id: 'details', label: 'Details', onClick: details },
    ] });
    await act(async () => root.render(<><fieldset disabled><input /></fieldset><WorkspaceNotifications /></>));
    const card = () => document.querySelector('[data-testid="workspace-notification"]')!;
    expect(card().closest('[data-testid="workspace-notifications"]')).not.toBeNull();
    expect(card().textContent).toContain('Uploading models');
    expect(card().textContent).toContain('Sending model 2');
    expect(card().querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(card().querySelector('[data-slot="toast-close"]')).toBeNull();
    const buttons = card().querySelectorAll<HTMLButtonElement>('button');
    expect([...buttons].map(button => button.textContent)).toEqual(['Stop transfer', 'Details']);
    await act(async () => buttons[1].click());
    expect(details).toHaveBeenCalledOnce();
    const button = buttons[0];
    expect(button.closest('fieldset[disabled]')).toBeNull();
    await act(async () => button.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Stopping…');
    await act(async () => button.click());
    expect(cancel).toHaveBeenCalledOnce();
    expect(card().textContent).toContain('Stopping transfer…');
    await act(async () => {
      notifications.getState().finishOperation(token, { title: 'Transfer stopped', message: 'Nothing was uploaded.', severity: 'info' });
    });
    expect(card().querySelector('[role="progressbar"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="workspace-notification"]')).toHaveLength(1);
    expect(card().textContent).toContain('Transfer stopped');
    expect(card().querySelectorAll('button')).toHaveLength(1);
    await act(async () => root.render(<WorkspaceNotifications visible={false} />));
    expect(document.querySelector<HTMLElement>('[data-testid="workspace-notifications"]')?.hidden).toBe(true);
    await act(async () => root.render(<WorkspaceNotifications />));
    await act(async () => card().querySelector<HTMLButtonElement>('[data-slot="toast-close"]')!.click());
    expect(document.querySelector('[data-testid="workspace-notification"]')).toBeNull();
  });

  it('supports indeterminate progress and allows the caller to make a running card dismissible', async () => {
    const token = notifications.getState().beginOperation({ key: 'download', plateId: 'a', title: 'Downloading',
      message: 'Waiting for response', severity: 'info', progress: { value: null, label: 'Download progress' } });
    await act(async () => root.render(<WorkspaceNotifications />));
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBeNull();
    expect(document.querySelector('[data-slot="toast-close"]')).not.toBeNull();
    await act(async () => notifications.getState().updateOperation(token, { progress: { value: 150, label: 'Download progress' } }));
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
  });
});
