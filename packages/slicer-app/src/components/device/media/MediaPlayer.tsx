import { useEffect, useRef, useState } from 'react';
import type { MediaDescriptor, PrinterMedia } from '@orca/printer-control/domain';
import { startMediaPlayback, type PlaybackState } from './playback';

/** Resource lifetime belongs to the viewing owner; this component owns only presentation. */
export function MediaPlayer({ descriptor, media, onError }: {
  descriptor: MediaDescriptor;
  media: Pick<PrinterMedia, 'readStream'>;
  onError: (message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null), image = useRef<HTMLImageElement>(null);
  const player = useRef<ReturnType<typeof startMediaPlayback> | null>(null);
  const [state, setState] = useState<PlaybackState>('connecting');
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  useEffect(() => {
    const controller = new AbortController();
    const active = startMediaPlayback({ descriptor, media, video: video.current!, image: image.current!,
      signal: controller.signal, onState: setState });
    player.current = active;
    void active.done.catch(error => { if (!controller.signal.aborted) onErrorRef.current(error.message); });
    return () => { controller.abort(); active.stop(); player.current = null; };
  }, [descriptor, media]);
  return <div className="relative min-h-24 overflow-hidden rounded bg-black" data-testid="camera-player">
    <video ref={video} className="max-h-96 w-full object-contain" muted playsInline aria-label="Live camera" />
    <img ref={image} className="max-h-96 w-full object-contain" alt="Live camera" hidden />
    {state === 'connecting' && <span role="status" className="absolute left-2 top-2 rounded bg-black/70 px-2 text-sm text-white">Connecting…</span>}
    {state === 'paused' && <button className="absolute inset-0 text-white" onClick={() => void player.current?.play()}>Play video</button>}
  </div>;
}
