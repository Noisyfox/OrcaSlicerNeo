import type { MediaDescriptor, PrinterMedia } from '@orca/printer-control/domain';
import { cancellable, event, PlaybackError } from './playback';

/** Finite MSE delivery: pull disk packets only as buffer capacity permits, restart from indexed cache on seek. */
export function startStoredPlayback(descriptor: MediaDescriptor, media: Pick<PrinterMedia, 'readStream'>,
  video: HTMLVideoElement, onError: (message: string) => void) {
  const lifetime = new AbortController();
  let current: AbortController | undefined, serial = Promise.resolve(), url: string | undefined;
  let ranges = descriptor.presentation.kind === 'video' ? descriptor.presentation.cachedRanges ?? [] : [];
  let stopped = false;
  async function run(start: number, signal: AbortSignal) {
    const presentation = descriptor.presentation;
    if (presentation.kind !== 'video' || presentation.delivery.transport !== 'mse-fmp4' ||
      !MediaSource.isTypeSupported(presentation.delivery.mimeType)) throw new PlaybackError('This video format cannot be played here. Download it to use a system player.');
    const iterator = media.readStream({ media: descriptor.ref, streamId: presentation.delivery.streamId, startSeconds: start }, { signal })[Symbol.asyncIterator]();
    let source: MediaSource | undefined, buffer: SourceBuffer | undefined, sequence = 0, generation: number | undefined;
    let started = false, pendingBytes = 0;
    const appended: { end: number; bytes: number }[] = [];
    try {
      for (;;) {
        signal.throwIfAborted();
        if (buffer?.buffered.length && started) {
          const end = buffer.buffered.end(buffer.buffered.length - 1);
          // Remove consumed data, then stop pulling while paused/slow or ahead of playback.
          const cutoff = Math.max(0, video.currentTime - (pendingBytes >= 16 * 1024 * 1024 ? 0.1 : 5));
          if (cutoff > buffer.buffered.start(0)) {
            await event(buffer, 'updateend', signal, () => buffer!.remove(0, cutoff));
            while (appended.length && appended[0].end <= cutoff) pendingBytes -= appended.shift()!.bytes;
          }
          if (end - video.currentTime > 20 || pendingBytes >= 16 * 1024 * 1024) {
            await cancellable(new Promise<void>(resolve => setTimeout(resolve, 100)), signal); continue;
          }
        }
        const next = await cancellable(iterator.next(), signal, 35_000);
        if (next.done) {
          if (!started || !source || source.readyState !== 'open') throw new PlaybackError('The video ended without a playable frame.');
          source.endOfStream();
          await cancellable(new Promise<void>(() => {}), signal); return;
        }
        const packet = next.value;
        if (packet.sequence !== sequence++ || !Number.isSafeInteger(packet.generation) || packet.generation < 0 || !packet.bytes.length || packet.bytes.length > 8 * 1024 * 1024 ||
          generation !== undefined && generation !== packet.generation) throw new PlaybackError('Stored video delivery was interrupted.');
        generation = packet.generation;
        if (packet.kind === 'init') {
          if (packet.sequence !== 0 || packet.mimeType !== presentation.delivery.mimeType) throw new PlaybackError('Invalid video initialization.');
          source = new MediaSource(); url = URL.createObjectURL(source);
          await event(source, 'sourceopen', signal, () => { video.src = url!; });
          buffer = source.addSourceBuffer(packet.mimeType);
        } else if (packet.kind !== 'segment' || !buffer) throw new PlaybackError('Invalid video fragment.');
        await event(buffer!, 'updateend', signal, () => buffer!.appendBuffer(Uint8Array.from(packet.bytes)));
        if (presentation.durationSeconds !== null && source!.duration !== presentation.durationSeconds) source!.duration = presentation.durationSeconds;
        if (buffer!.buffered.length) {
          const end = buffer!.buffered.end(buffer!.buffered.length - 1);
          appended.push({ end, bytes: packet.bytes.length }); pendingBytes += packet.bytes.length;
          if (!started && end > start) {
            video.currentTime = Math.max(start, buffer!.buffered.start(0)); started = true;
            void video.play().catch(() => {}); // User-visible Play control handles autoplay restrictions.
          }
        }
        if (!started && pendingBytes > 16 * 1024 * 1024) throw new PlaybackError('This keyframe interval exceeds the playback buffer. Download the file to continue.');
      }
    } finally { await iterator.return?.(); video.pause(); video.removeAttribute('src'); video.load(); if (url) URL.revokeObjectURL(url); url = undefined; }
  }
  const seek = (seconds: number) => {
    if (stopped || !Number.isFinite(seconds) || !ranges.some(r => seconds >= r.startSeconds && seconds < r.endSeconds)) return false;
    current?.abort(); const controller = new AbortController(); current = controller;
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    serial = serial.then(async () => { if (!signal.aborted) await run(seconds, signal); }).catch(error => {
      if (!signal.aborted) onError(error instanceof PlaybackError ? error.message : 'Video playback failed. Download the file to use a system player.');
    }); return true;
  };
  const failed = () => { current?.abort(); onError('This video could not be decoded. Download it to use a system player.'); };
  video.addEventListener('error', failed); seek(0);
  return { seek, setRanges(next: typeof ranges) { ranges = next; },
    async stop() { stopped = true; lifetime.abort(); current?.abort(); video.removeEventListener('error', failed); await serial; },
  };
}
