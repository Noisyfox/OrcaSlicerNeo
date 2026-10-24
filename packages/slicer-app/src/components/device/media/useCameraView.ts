import { useEffect, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';
import { cameraClientCapabilities } from './playback';

/** The keyed Camera card owns viewing intent; hidden views keep intent but release resources. */
export function useCameraView(media: D.PrinterMedia, target: D.TargetRequest, cameraId: D.Id<'camera'>, visible: boolean, available: boolean) {
  const [wanted, setWanted] = useState(false), [attempt, setAttempt] = useState(0);
  const [descriptor, setDescriptor] = useState<D.MediaDescriptor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden');
  const previous = useRef(Promise.resolve()), active = useRef<AbortController | null>(null);
  useEffect(() => {
    const change = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => { if (!available) setWanted(false); }, [available]);
  useEffect(() => {
    setDescriptor(null);
    if (!wanted || !visible || !documentVisible || !available) return;
    const abort = new AbortController(); active.current = abort;
    const { signal } = abort;
    let current: D.MediaDescriptor | null = null;
    let renewTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => { if (!signal.aborted) { setError(message); setWanted(false); setDescriptor(null); abort.abort(); } };
    const done = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    const accept = (next: D.MediaDescriptor) => {
      if (signal.aborted || current && next.revision < current.revision) return;
      if (current && (next.ref.id !== current.ref.id || next.ref.printerId !== current.ref.printerId || next.ref.routeId !== current.ref.routeId)) {
        fail('Camera resource changed unexpectedly.'); return;
      }
      current = next; setDescriptor(next); clearTimeout(renewTimer);
      if (next.expiresAtMs !== null) {
        const remaining = next.expiresAtMs - Date.now();
        if (remaining <= 0) { fail('Camera access expired.'); return; }
        // Renew with time to spare without spinning on short provider leases.
        renewTimer = setTimeout(() => { void (async () => {
          const result = await media.renew(next.ref, { signal });
          if (signal.aborted) return;
          if (!result.ok) fail(result.error.message);
          else if (result.value.expiresAtMs !== null && result.value.expiresAtMs <= next.expiresAtMs!) fail('Camera access could not be renewed.');
          else accept(result.value);
        })().catch(() => fail('Camera access could not be renewed.')); }, Math.max(1, remaining - Math.min(30_000, remaining / 2)));
      }
    };
    const before = previous.current;
    previous.current = (async () => {
      await before;
      if (signal.aborted) return;
      setError(null);
      try {
        const opened = await media.open({ target, requestId: crypto.randomUUID() as D.Id<'request'>,
          source: { kind: 'camera', cameraId }, client: cameraClientCapabilities() }, { signal });
        if (!opened.ok) { fail(opened.error.message); return; }
        current = opened.value;
        if (signal.aborted) return; // finally closes late opens, including providers ignoring cancellation.
        accept(opened.value);
        void (async () => {
          for await (const event of media.watch(opened.value.ref, { signal })) {
            if (signal.aborted) return;
            if (event.payload.type === 'descriptor') accept(event.payload.descriptor);
            if (event.payload.type === 'error') { fail(event.payload.error.message); return; }
            if (event.payload.type === 'closed') { fail('Camera viewing ended.'); return; }
            if (event.payload.type === 'state' && event.payload.state === 'interrupted') { fail('Camera connection was interrupted.'); return; }
          }
          fail('Camera connection ended.');
        })().catch(() => fail('Camera connection was interrupted.'));
        await done;
      } catch { fail('Unable to open the camera.'); }
      finally {
        abort.abort(); clearTimeout(renewTimer);
        if (current) await media.close(current.ref).catch(() => {});
      }
    })();
    return () => { abort.abort(); clearTimeout(renewTimer); if (active.current === abort) active.current = null; };
  }, [media, target.printerId, target.routeId, target.expectedConfigurationRevision, cameraId, wanted, attempt, visible, documentVisible, available]);
  return { descriptor, error, wanted,
    play: () => { setError(null); setWanted(true); setAttempt(value => value + 1); },
    stop: () => { active.current?.abort(); setDescriptor(null); setError(null); setWanted(false); },
    playbackFailed: (message: string) => { active.current?.abort(); setDescriptor(null); setWanted(false); setError(message); },
  };
}
