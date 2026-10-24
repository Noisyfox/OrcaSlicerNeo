/** Browser-only delivery consumer. The resource owner opens/renews/closes media separately. */
import type { MediaClientCapabilities, MediaDescriptor, MediaStreamPacket, PrinterMedia, VideoDelivery } from '@orca/printer-control/domain';

export type PlaybackState = 'connecting' | 'playing' | 'paused';
export interface PlaybackOptions {
  descriptor: MediaDescriptor;
  media: Pick<PrinterMedia, 'readStream'>;
  video: HTMLVideoElement;
  image: HTMLImageElement;
  signal?: AbortSignal;
  onState?: (state: PlaybackState) => void;
}
const MAX_PACKET_BYTES = 16 * 1024 * 1024;

/** A browser failure must not expose a signed URL or a provider credential. */
export class PlaybackError extends Error {}
const aborted = () => new DOMException('Playback stopped', 'AbortError');

function cancellable<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(signal.reason ?? aborted()); };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { cleanup(); reject(new PlaybackError('Camera playback timed out')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) stop();
  });
}

function event(target: EventTarget, name: string, signal: AbortSignal, action?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(name, ok); target.removeEventListener('error', bad); signal.removeEventListener('abort', stop); };
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new PlaybackError('Media decoding failed')); };
    const stop = () => { cleanup(); reject(signal.reason ?? aborted()); };
    const timer = setTimeout(() => { cleanup(); reject(new PlaybackError('Media decoder timed out')); }, 5000);
    target.addEventListener(name, ok, { once: true }); target.addEventListener('error', bad, { once: true });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) { stop(); return; }
    try { action?.(); } catch (error) { cleanup(); reject(error); }
  });
}

export function cameraClientCapabilities(): MediaClientCapabilities {
  const video: MediaClientCapabilities['video'][number][] = [
    { transport: 'jpeg-frames', codecIds: ['jpeg'] }, { transport: 'mjpeg', codecIds: ['jpeg'] },
    { transport: 'progressive-http', codecIds: ['h264'] }, { transport: 'hls', codecIds: ['h264'] },
  ];
  if (typeof MediaSource !== 'undefined') video.push({ transport: 'mse-fmp4', codecIds: ['h264'] });
  return { video, imageMimeTypes: ['image/jpeg', 'image/png'], contentFormats: [] };
}

/** Protocol and HTTPS policy is enforced before assigning a remote source. CSP/CORS still apply. */
export function playbackUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (new URL(base).protocol === 'https:' && url.protocol !== 'https:')) {
    throw new PlaybackError('This media URL is not supported');
  }
  return url.href;
}

export function startMediaPlayback(options: PlaybackOptions) {
  const { descriptor, media, video, image, onState } = options;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const presentation = descriptor.presentation;
  let blobUrl: string | undefined, hls: { destroy(): void } | undefined;
  let source: MediaSource | undefined, buffer: SourceBuffer | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let frameCallback: number | undefined, videoEpoch = 0;
  let lastFrameAt = Date.now(), autoplayBlocked = false;
  let rejectFailure: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  // Capture immediate media errors even while waiting for an IPC packet.
  const failed = () => rejectFailure(new PlaybackError('Media playback failed'));
  const playing = () => { lastFrameAt = Date.now(); onState?.('playing'); };
  const watchdog = setInterval(() => {
    if (presentation.kind === 'video' && presentation.live && 'streamId' in presentation.delivery && !autoplayBlocked && Date.now() - lastFrameAt > 15000) {
      rejectFailure(new PlaybackError('Camera stopped displaying frames'));
    }
  }, 1000);
  const waiting = () => onState?.('connecting');
  video.addEventListener('error', failed); image.addEventListener('error', failed);
  video.addEventListener('waiting', waiting);
  video.muted = true; video.playsInline = true;
  onState?.('connecting');
  const revoke = () => { if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = undefined; };
  const resetVideo = () => {
    videoEpoch++; lastFrameAt = Date.now(); video.pause(); video.removeAttribute('src'); video.load(); revoke(); source = undefined; buffer = undefined;
  };
  const play = async () => {
    const epoch = videoEpoch;
    try { await video.play(); autoplayBlocked = false; lastFrameAt = Date.now(); } catch (error) {
      if (!signal.aborted && epoch === videoEpoch) {
        if (error instanceof DOMException && error.name === 'NotAllowedError') { autoplayBlocked = true; onState?.('paused'); }
        else failed();
      }
    }
  };
  const observeFrame = () => {
    if (signal.aborted) return;
    playing(); frameCallback = video.requestVideoFrameCallback(observeFrame);
  };
  frameCallback = video.requestVideoFrameCallback(observeFrame);
  const setExpiresAt = (at: number | null) => {
    clearTimeout(expiry);
    if (at !== null && !signal.aborted) expiry = setTimeout(() => rejectFailure(new PlaybackError('Camera access expired')),
      Math.max(0, Math.min(2 ** 31 - 1, at - Date.now())));
  };
  setExpiresAt(descriptor.expiresAtMs);

  async function append(bytes: Uint8Array) {
    const update = () => event(buffer!, 'updateend', signal, () => buffer!.appendBuffer(Uint8Array.from(bytes)));
    if (presentation.kind !== 'video' || !source || !buffer) throw new PlaybackError('Missing video initialization');
    if (buffer.buffered.length) {
      const end = buffer.buffered.end(buffer.buffered.length - 1);
      if (presentation.live && end - video.currentTime > 1.5) video.currentTime = Math.max(buffer.buffered.start(0), end - 0.25);
      const cutoff = video.currentTime - 5;
      if (cutoff > buffer.buffered.start(0)) await event(buffer, 'updateend', signal, () => buffer!.remove(0, cutoff));
      if (end - buffer.buffered.start(0) > 30) throw new PlaybackError('Camera buffer limit exceeded');
    }
    await update();
  }

  async function binary(delivery: Extract<VideoDelivery, { streamId: unknown }>) {
    if (!('streamId' in delivery)) return;
    const stream = media.readStream({ media: descriptor.ref, streamId: delivery.streamId }, { signal });
    const iterator = stream[Symbol.asyncIterator]();
    let generation = -1, sequence = -1;
    let pending: MediaStreamPacket | undefined, rendering: Promise<void> | undefined;
    const renderJpeg = async () => {
      while (pending && !signal.aborted) {
        const packet = pending; pending = undefined;
        const next = URL.createObjectURL(new Blob([Uint8Array.from(packet.bytes)], { type: 'image/jpeg' }));
        const decoded = new Image(); decoded.src = next;
        try {
          await cancellable(decoded.decode(), signal, 5000);
          if (signal.aborted || packet.generation !== generation) { URL.revokeObjectURL(next); continue; }
          image.src = next; revoke(); blobUrl = next; playing();
        } catch (error) { URL.revokeObjectURL(next); throw error; }
      }
    };
    try {
      while (!signal.aborted) {
        const next = await cancellable(iterator.next(), signal, 15000);
        if (next.done) break;
        const packet = next.value;
        if (!Number.isSafeInteger(packet.generation) || packet.generation < 0 || !Number.isSafeInteger(packet.sequence)
          || packet.sequence < 0 || !packet.bytes.length || packet.bytes.length > MAX_PACKET_BYTES) throw new PlaybackError('Invalid camera packet');
        if (packet.generation < generation) continue;
        if (packet.generation !== generation) {
          if (packet.sequence !== 0 || (delivery.transport === 'mse-fmp4' ? packet.kind !== 'init' : packet.kind !== 'jpeg')) throw new PlaybackError('Camera stream lost initialization');
          generation = packet.generation; sequence = -1;
          if (delivery.transport === 'mse-fmp4') resetVideo();
        }
        if (packet.sequence !== sequence + 1) throw new PlaybackError('Camera stream has a gap');
        sequence = packet.sequence;
        if (delivery.transport === 'jpeg-frames') {
          if (packet.kind !== 'jpeg') throw new PlaybackError('Unexpected camera packet');
          pending = packet;
          if (!rendering) {
            rendering = renderJpeg().catch(() => failed()).finally(() => { rendering = undefined; });
          }
        } else if (packet.kind === 'init') {
          if (sequence !== 0 || !MediaSource.isTypeSupported(packet.mimeType)) throw new PlaybackError('Unsupported camera codec');
          source = new MediaSource(); blobUrl = URL.createObjectURL(source);
          await event(source, 'sourceopen', signal, () => { video.src = blobUrl!; });
          buffer = source.addSourceBuffer(packet.mimeType);
          await append(packet.bytes); void play();
        } else {
          if (packet.kind !== 'segment') throw new PlaybackError('Unexpected camera packet');
          await append(packet.bytes);
        }
      }
      await rendering;
      if (signal.aborted) return;
      if (presentation.kind === 'video' && presentation.live) throw new PlaybackError('Camera stream ended');
      if (source?.readyState === 'open') source.endOfStream();
      await cancellable(new Promise<void>(resolve => video.addEventListener('ended', () => resolve(), { once: true, signal })), signal);
    } finally { void iterator.return?.().catch(() => {}); }
  }

  async function run() {
    if (presentation.kind !== 'video') throw new PlaybackError('Unsupported media presentation');
    const delivery = presentation.delivery;
    image.hidden = !['jpeg-frames', 'mjpeg'].includes(delivery.transport); video.hidden = !image.hidden;
    if (delivery.transport === 'mse-fmp4' || delivery.transport === 'jpeg-frames') {
      if (delivery.transport === 'mse-fmp4' && (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(delivery.mimeType))) throw new PlaybackError('Unsupported camera codec');
      return binary(delivery);
    }
    if (delivery.transport === 'webrtc') throw new PlaybackError('WebRTC playback is not supported');
    const url = playbackUrl(delivery.url, document.baseURI);
    const cors = delivery.credentials === 'include' ? 'use-credentials' : 'anonymous';
    video.crossOrigin = cors; image.crossOrigin = cors;
    if (delivery.transport === 'mjpeg') {
      image.addEventListener('load', playing, { signal }); image.src = url;
    } else if (delivery.transport === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      const { default: Hls } = await import('hls.js');
      signal.throwIfAborted();
      if (!Hls.isSupported()) throw new PlaybackError('HLS playback is not supported');
      const engine = new Hls({ enableWorker: false, backBufferLength: 5, maxBufferLength: 10, maxMaxBufferLength: 20,
        maxBufferSize: 16 * 1024 * 1024, xhrSetup: xhr => { xhr.withCredentials = delivery.credentials === 'include'; } });
      hls = engine;
      engine.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) failed(); });
      engine.on(Hls.Events.MANIFEST_PARSED, () => { void play(); });
      engine.loadSource(url); engine.attachMedia(video);
    } else {
      if (!video.canPlayType(delivery.mimeType)) throw new PlaybackError('Unsupported media format');
      video.src = url; void play();
    }
    await cancellable(new Promise<void>(() => {}), signal);
  }

  const done = Promise.race([run(), failure]).finally(() => {
    controller.abort(aborted()); clearTimeout(expiry); clearInterval(watchdog); hls?.destroy();
    if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
    video.removeEventListener('error', failed); image.removeEventListener('error', failed); video.removeEventListener('waiting', waiting);
    resetVideo(); image.removeAttribute('src'); image.removeAttribute('crossorigin'); video.removeAttribute('crossorigin');
  }).catch(error => { if (!options.signal?.aborted && !(error instanceof DOMException && error.name === 'AbortError')) throw new PlaybackError(error instanceof PlaybackError ? error.message : 'Camera playback failed'); });
  return { done, play, setExpiresAt, stop: () => controller.abort(aborted()) };
}
