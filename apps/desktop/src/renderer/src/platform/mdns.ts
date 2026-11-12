import type { MdnsDiscovery, MdnsService } from '@orca/network-discovery';
import type { MdnsBridge } from '../../../shared/mdns';

/** Adapt host snapshots to a cancellable stream without exposing IPC to agents. */
export function electronMdns(bridge: MdnsBridge): MdnsDiscovery {
  return { async *browse(serviceType, options) {
    const signal = options?.signal;
    if (signal?.aborted) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let previous = new Map<string, string>();
    try {
      await bridge.start(id, serviceType);
      while (!controller.signal.aborted) {
        const services = await bridge.snapshot(id);
        if (controller.signal.aborted) return;
        const next = new Map<string, string>();
        for (const service of services) next.set(service.id, JSON.stringify(service));
        for (const key of previous.keys()) if (!next.has(key)) yield { type: 'removed', id: key };
        for (const service of services) if (previous.get(service.id) !== next.get(service.id)) yield { type: 'upsert', service: service as MdnsService };
        previous = next;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 250);
          controller.signal.addEventListener('abort', done, { once: true });
          if (controller.signal.aborted) done();
        });
      }
    } finally {
      controller.abort();
      signal?.removeEventListener('abort', abort);
      await bridge.stop(id).catch(() => undefined);
    }
  } };
}
