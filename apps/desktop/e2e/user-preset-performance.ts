import type { Locator, Page } from '@playwright/test';
import type { HistoryRestoreProbe } from '../../../packages/slicer-app/src/e2e/historyProbeTypes';

export interface UserPresetTiming {
  operation: 'delete' | 'undo';
  ms: number;
  boundary: string;
}

declare global {
  interface Window {
    __orcaUserPresetTiming?: Promise<UserPresetTiming>;
  }
}

/** Start at DOM click dispatch, excluding Playwright's actionability retries. */
async function measure(page: Page, button: Locator, operation: UserPresetTiming['operation']): Promise<UserPresetTiming> {
  await button.evaluate((element, operation) => {
    const api = (window as unknown as { __orcaE2e?: HistoryRestoreProbe }).__orcaE2e;
    const beforeStatus = api?.historyNativeStatus?.();
    const beforeLifecycle = api?.historyRestoreLifecycle?.();
    const beforeProjection = api?.historyDiagnostics?.().app.projection.count;
    if (!api || !beforeStatus || !beforeLifecycle || beforeProjection === undefined || beforeLifecycle.phase !== 'idle')
      throw new Error('preset timing requires an idle history lifecycle');
    const dialog = operation === 'delete' ? element.closest('[role="dialog"]') : null;
    if (operation === 'delete' && !dialog) throw new Error('delete confirmation dialog is missing');

    window.__orcaUserPresetTiming = new Promise((resolve, reject) => {
      element.addEventListener('click', () => {
        const startedAt = performance.now();
        const timer = setInterval(() => {
          const lifecycle = api.historyRestoreLifecycle!();
          const status = api.historyNativeStatus!();
          const projection = api.historyDiagnostics!().app.projection.count;
          if (lifecycle.error || performance.now() - startedAt > 30_000) {
            clearInterval(timer);
            reject(new Error(lifecycle.error ?? 'preset publication did not complete'));
            return;
          }
          const published = status && status.cursor !== beforeStatus.cursor && status.activeTransactionId === null;
          const completed = operation === 'delete'
            // Keep the actual dialog node: its title/button changes while saving
            // and during the exit animation, before the node is removed.
            ? !dialog!.isConnected && published && lifecycle.phase === 'idle'
            : published && lifecycle.phase === 'idle' && lifecycle.revision > beforeLifecycle.revision &&
              projection === beforeProjection + 1;
          if (completed) {
            clearInterval(timer);
            resolve({ operation, ms: performance.now() - startedAt,
              boundary: operation === 'delete' ? 'DOM click to detached confirmation and published history'
                : 'DOM click to new cursor, completed projection and idle restore lifecycle' });
          }
        }, 5);
      }, { once: true, capture: true });
    });
  }, operation);
  await button.click();
  return page.evaluate(async () => {
    const pending = window.__orcaUserPresetTiming;
    if (!pending) throw new Error('preset timing was not armed');
    const result = await pending;
    delete window.__orcaUserPresetTiming;
    return result;
  });
}

export const measureUserPresetDelete = (page: Page) => measure(page,
  page.getByRole('button', { name: 'Delete preset', exact: true }), 'delete');
export const measureUserPresetUndo = (page: Page) => measure(page, page.getByTestId('history-undo'), 'undo');
