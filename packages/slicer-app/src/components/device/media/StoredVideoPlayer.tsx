import { useEffect, useRef, useState } from 'react';
import type { MediaDescriptor, PrinterMedia, VideoDelivery } from '@orca/printer-control/domain';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { startStoredPlayback } from './storedPlayback';

export function StoredVideoPlayer({ descriptor, media, onError }: { descriptor: MediaDescriptor; media: PrinterMedia; onError: (message: string) => void }) {
  const presentation = descriptor.presentation;
  if (presentation.kind === 'video' && presentation.delivery.transport === 'progressive-http') {
    return <ProgressiveVideoPlayer delivery={presentation.delivery} onError={onError} />;
  }
  return <BufferedVideoPlayer descriptor={descriptor} media={media} onError={onError} />;
}

function ProgressiveVideoPlayer({ delivery, onError }: { delivery: Extract<VideoDelivery, { transport: 'progressive-http' | 'hls' | 'mjpeg' }>; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current!;
    element.src = delivery.url;
    return () => { element.pause(); element.removeAttribute('src'); element.load(); };
  }, [delivery.url]);
  return <div data-testid="stored-video-player">
    <video ref={video} className="aspect-video max-h-[55vh] w-full bg-black object-contain" aria-label="Stored video" controls autoPlay muted playsInline
      crossOrigin={delivery.credentials === 'include' ? 'use-credentials' : 'anonymous'}
      onError={() => onError('Stored video could not be played.')} />
  </div>;
}

function BufferedVideoPlayer({ descriptor, media, onError }: { descriptor: MediaDescriptor; media: PrinterMedia; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null), player = useRef<ReturnType<typeof startStoredPlayback> | null>(null);
  const cleanup = useRef(Promise.resolve()), latest = useRef({ descriptor, onError }); latest.current = { descriptor, onError };
  const [position, setPosition] = useState(0), [paused, setPaused] = useState(false);
  const presentation = descriptor.presentation;
  const identity = JSON.stringify([descriptor.ref, presentation.kind === 'video' && presentation.delivery]);
  useEffect(() => {
    let active = true, instance: ReturnType<typeof startStoredPlayback> | undefined;
    void cleanup.current.then(() => {
      if (!active) return;
      instance = startStoredPlayback(latest.current.descriptor, media, video.current!, message => latest.current.onError(message)); player.current = instance;
    });
    return () => { active = false; if (instance) cleanup.current = instance.stop(); if (player.current === instance) player.current = null; };
  }, [identity, media]);
  const ranges = presentation.kind === 'video' ? presentation.cachedRanges ?? [] : [];
  useEffect(() => { player.current?.setRanges(ranges); }, [ranges]);
  const end = ranges.at(-1)?.endSeconds ?? 0;
  const format = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return <div className="space-y-2" data-testid="stored-video-player">
    <video ref={video} className="aspect-video max-h-[55vh] w-full bg-black object-contain" aria-label="Stored video" muted playsInline
      onTimeUpdate={() => setPosition(video.current?.currentTime ?? 0)} onPause={() => setPaused(true)} onPlay={() => setPaused(false)} />
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={() => { if (video.current?.ended) player.current?.seek(0); else if (video.current?.paused) void video.current.play().catch(() => {}); else video.current?.pause(); }}>{paused ? 'Play' : 'Pause'}</Button>
      <Slider aria-label="Seek within downloaded video" className="min-w-0 flex-1" min={0} max={Math.max(0, end - 0.001)} step={0.1}
        value={[Math.min(position, Math.max(0, end - 0.001))]} disabled={!end} onValueChange={value => player.current?.seek(Array.isArray(value) ? value[0] : value)} />
      <span className="text-xs tabular-nums">{format(position)} / {format(presentation.kind === 'video' ? presentation.durationSeconds ?? 0 : 0)}</span>
      <Button variant="outline" onClick={() => void video.current?.requestFullscreen().catch(() => {})}>Fullscreen</Button>
    </div>
    <p className="text-xs text-muted-foreground">Seek within downloaded video · {format(end)} available</p>
  </div>;
}
