// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import type { PrinterService } from '@orca/printer-control/domain';
import { sendActivity } from '@orca/printer-control/send-activity';
import { useSendExitGuard } from './SendExitGuard';
it('offers return without cancellation, then requests local cancellation before allowing exit', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const service = {} as PrinterService, cancelled = vi.fn(), lease = sendActivity(service).begin(cancelled);
  let confirm!: () => Promise<boolean>;
  function Fixture() { const guard = useSendExitGuard(service); confirm = guard.confirm; return guard.dialog; }
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(<Fixture />));
    let closing!: Promise<boolean>;
    await act(async () => { closing = confirm(); });
    expect(element.textContent).toContain('Sending is still in progress');
    await act(async () => element.querySelector('button')!.click());
    expect(await closing).toBe(false); expect(cancelled).not.toHaveBeenCalled();
    await act(async () => { closing = confirm(); });
    await act(async () => element.querySelectorAll('button')[1].click());
    expect(await closing).toBe(true); expect(cancelled).toHaveBeenCalledOnce(); expect(lease.signal.aborted).toBe(true);
    lease.finish(); expect(await confirm()).toBe(true);
  } finally { await act(async () => root.unmount()); element.remove(); }
});
