import type { Page } from '@playwright/test';

/** Observe the typed Worker transport. Only an explicitly armed race check
 * clicks the real Cancel DOM button at the observed native terminal boundary. */
export async function installSliceReceiptObserver(page: Page, operations = ['slicePlate', 'cancel']): Promise<void> {
  await page.evaluate((operations) => {
    const target = window as unknown as { __orcaSliceReceipts: unknown[]; __orcaLateCancel?: { armed: boolean; firedAt?: number; sliceRequestId?: number } };
    target.__orcaSliceReceipts = [];
    const observed = new WeakMap<object, Map<number, string>>();
    for (const prototype of [MessagePort.prototype, Worker.prototype]) {
      const original = prototype.postMessage;
      prototype.postMessage = function (this: MessagePort | Worker, message: any, ...args: any[]) {
        let requests = observed.get(this);
        if (!requests) {
          requests = new Map(); observed.set(this, requests);
          const observe = (event: Event) => {
            const response = (event as MessageEvent).data;
            const op = requests!.get(response?.id);
            if(response?.type === 'progress' && [...requests!.values()].includes('slicePlate'))
              target.__orcaSliceReceipts.push({at:performance.now(),direction:'progress',percent:response.percent,text:response.text});
            if (response?.type === 'response' && op) {
              target.__orcaSliceReceipts.push({ at: performance.now(), direction: 'response', op, ...response });
              requests!.delete(response.id);
              // Fix the late-Cancel race order for a separate functional check:
              // native terminal observed, renderer Slice continuation not run.
              if(op === 'slicePlate' && response.result?.ok === true && target.__orcaLateCancel?.armed) {
                const button=document.querySelector<HTMLButtonElement>('[data-testid="btn-cancel-slice"]');
                if(button && !button.disabled) {
                  target.__orcaLateCancel={armed:false,firedAt:performance.now(),sliceRequestId:response.id};
                  button.click();
                }
              }
            }
          };
          // Electron already owns port.onmessage. Preserve its exact consumer,
          // observing synchronously before it resolves the request promise.
          const consumer = this.onmessage;
          if (consumer) this.onmessage = (event: MessageEvent) => { observe(event); Reflect.apply(consumer, this, [event]); };
          else this.addEventListener('message', observe, { capture: true });
        }
        if (message?.type === 'request' && operations.includes(message.op)) {
          requests.set(message.id, message.op);
          target.__orcaSliceReceipts.push({ at: performance.now(), direction: 'request',
            type: message.type, id: message.id, op: message.op });
        }
        return Reflect.apply(original, this, [message, ...args]);
      } as typeof original;
    }
  }, operations);
}

export const readSliceReceipts = (page: Page) => page.evaluate(() =>
  (window as unknown as { __orcaSliceReceipts: unknown[] }).__orcaSliceReceipts);
