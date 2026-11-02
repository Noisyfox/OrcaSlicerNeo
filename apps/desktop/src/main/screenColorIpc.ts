import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { NativeScreenColorSampler } from '@orca/color-sampler-native';
import { normalizeScreenColorResult, type ScreenColorResult } from '../../../../packages/platform-contract/src/screenColor';

/** One native operation per host, owned by the current top-level renderer and request. */
export function createScreenColorIpc(options: {
  native: NativeScreenColorSampler | null;
  authorized: (event: IpcMainInvokeEvent) => boolean;
  restoreFocus: (sender: WebContents) => void;
}) {
  let active: { sender: WebContents; id: string; controller: AbortController } | null = null;
  const authorize = (event: IpcMainInvokeEvent) => {
    if (!options.authorized(event)) throw new Error('Screen color IPC request rejected');
  };
  const requestId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
  return {
    available(event: IpcMainInvokeEvent) { authorize(event); return options.native?.available === true; },
    async pick(event: IpcMainInvokeEvent, id: unknown): Promise<ScreenColorResult> {
      authorize(event);
      if (!requestId(id)) throw new Error('Invalid screen color request id');
      if (!options.native?.available || active) return { status: 'failed' };
      const sender = event.sender;
      const controller = new AbortController();
      const request = { sender, id, controller };
      active = request;
      const abort = () => controller.abort();
      sender.once('destroyed', abort);
      sender.once('render-process-gone', abort);
      sender.once('will-navigate', abort);
      try {
        const result = normalizeScreenColorResult(await options.native.pick(controller.signal));
        if (controller.signal.aborted) return { status: 'cancelled' };
        if (!sender.isDestroyed()) options.restoreFocus(sender);
        return result;
      } catch { return { status: controller.signal.aborted ? 'cancelled' : 'failed' }; }
      finally {
        sender.removeListener('destroyed', abort);
        sender.removeListener('render-process-gone', abort);
        sender.removeListener('will-navigate', abort);
        if (active === request) active = null;
      }
    },
    cancel(event: IpcMainInvokeEvent, id: unknown) {
      authorize(event);
      if (!requestId(id)) throw new Error('Invalid screen color request id');
      if (active?.sender === event.sender && active.id === id) active.controller.abort();
    },
    close() { active?.controller.abort(); options.native?.close(); },
  };
}
