// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { PrinterAlerts } from './PrinterAlerts';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const target = { printerId: 'printer' as D.Id<'printer'>, routeId: 'route' as D.Id<'route'> };
const action = (label: string): D.PrinterAction => ({ actionRef: { ...target, configurationRevision: 'r1', token: label as D.Id<'action-context'> }, label, description: null, expiresAtMs: null, availability: { kind: 'available' } });
const alert = (id = 'episode-1'): D.PrinterObservationMap['alerts'][number] => ({ id: id as D.Id<'alert'>, severity: 'warning', code: '0500808F', message: 'Nozzle camera lens is dirty.', actions: [action('Problem Solved and Resume'), action('Ignore this and Resume')], dialog: { title: 'Warning', dismissible: true, dismissAction: action('Close') } });
let root: Root;
let props: Parameters<typeof PrinterAlerts>[0];
async function render(patch: Partial<typeof props> = {}) {
  props = { ...props, ...patch };
  if (!root) { const container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  await act(async () => { root.render(<PrinterAlerts {...props} />); });
}
const dialog = () => document.querySelector('[role="dialog"]');
async function click(label: string) {
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === label)!.click(); });
}
function defaults() { return { alerts: [alert()], printerName: 'Workshop', visible: true, disabled: false, feedback: null, onInvoke: vi.fn(async () => true) }; }
afterEach(async () => { await act(async () => root?.unmount()); root = undefined as unknown as Root; document.body.innerHTML = ''; });
it('opens a modeless error once, invokes its exact action, and reopens only for a new episode or explicit details', async () => {
  await render(defaults());
  expect(dialog()?.textContent).toContain('Workshop · 0500808F');
  expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
  await click('Ignore this and Resume');
  expect(props.onInvoke).toHaveBeenCalledExactlyOnceWith(props.alerts[0].actions[1]);
  expect(dialog()).toBeNull();
  await render({ alerts: [alert()] });
  expect(dialog()).toBeNull();
  await click('View error details'); expect(dialog()).not.toBeNull();
  await click('Close');
  expect(props.onInvoke).toHaveBeenLastCalledWith(props.alerts[0].dialog!.dismissAction);
  expect(dialog()).toBeNull();
  await render({ alerts: [alert('episode-2')] }); expect(dialog()).not.toBeNull();
  await render({ alerts: [] }); expect(dialog()).toBeNull();
});
it('hides on dispatch like Orca, retains designated retries, disables stale actions, and closes locally while offline', async () => {
  const invoke = vi.fn(async () => false);
  await render({ ...defaults(), onInvoke: invoke });
  await click('Problem Solved and Resume'); expect(dialog()).toBeNull();
  await render({ feedback: 'Printer rejected the action.' });
  await click('View error details');
  expect(dialog()?.textContent).toContain('Printer rejected the action.');
  const retry = action('Retry'); retry.keepDialogOpen = true;
  await render({ alerts: [{ ...alert(), actions: [retry] }], onInvoke: vi.fn(async () => true), feedback: null });
  await click('Retry'); expect(dialog()).not.toBeNull();
  await render({ disabled: true });
  expect(dialog()?.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  const calls = vi.mocked(props.onInvoke).mock.calls.length;
  await click('Close'); expect(dialog()).toBeNull();
  expect(props.onInvoke).toHaveBeenCalledTimes(calls);
});
it('does not show errors over a hidden Device page, respects agent no-close presentation, and leaves ordinary alerts inline', async () => {
  await render({ ...defaults(), visible: false }); expect(dialog()).toBeNull();
  const value = alert(); value.dialog = { title: 'Error', dismissible: false };
  await render({ visible: true, alerts: [value] });
  expect(dialog()).not.toBeNull();
  expect([...dialog()!.querySelectorAll('button')].some(button => button.textContent === 'Close')).toBe(false);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(dialog()).not.toBeNull();
  await render({ alerts: [{ ...alert(), dialog: undefined }] });
  expect(dialog()).toBeNull();
  await click('Ignore this and Resume'); expect(props.onInvoke).toHaveBeenCalledOnce();
});
