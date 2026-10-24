import { useEffect, useRef, useState, type CSSProperties } from 'react';
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
  const [aspectRatio, setAspectRatio] = useState('16 / 9');
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  // Lease revisions do not replace a live stream; changed URL/delivery does.
  const identity = JSON.stringify([descriptor.ref, descriptor.presentation]);
  const latest = useRef(descriptor); latest.current = descriptor;
  useEffect(() => {
    setAspectRatio('16 / 9');
    const controller = new AbortController();
    let active: ReturnType<typeof startMediaPlayback> | undefined;
    // StrictMode replays setup/cleanup before this microtask. A discarded setup
    // must never attach the single-consumer stream: detaching it closes the view.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      active = startMediaPlayback({ descriptor: latest.current, media, video: video.current!, image: image.current!,
        signal: controller.signal, onState: setState });
      player.current = active;
      void active.done.catch(error => { if (!controller.signal.aborted) onErrorRef.current(error.message); });
    });
    return () => { controller.abort(); active?.stop(); if (player.current === active) player.current = null; };
  }, [identity, media]);
  useEffect(() => { player.current?.setExpiresAt(descriptor.expiresAtMs); }, [descriptor.expiresAtMs]);
  const videoSize = () => { if (video.current?.videoWidth && video.current.videoHeight) setAspectRatio(`${video.current.videoWidth} / ${video.current.videoHeight}`); };
  return <div className="printer-camera-viewport" style={{ '--camera-aspect-ratio': aspectRatio } as CSSProperties} data-testid="camera-player">
    <video ref={video} className="absolute inset-0 h-full w-full object-contain" muted playsInline aria-label="Live camera" onLoadedMetadata={videoSize} onResize={videoSize} />
    <img ref={image} className="absolute inset-0 h-full w-full object-contain" alt="Live camera" hidden onLoad={() => {
      if (image.current?.naturalWidth && image.current.naturalHeight) setAspectRatio(`${image.current.naturalWidth} / ${image.current.naturalHeight}`);
    }} />
    {state === 'connecting' && <span role="status" className="absolute left-2 top-2 rounded bg-black/70 px-2 text-sm text-white">Connecting…</span>}
    {state === 'paused' && <button className="absolute inset-0 text-white" onClick={() => void player.current?.play()}>Play video</button>}
  </div>;
}
