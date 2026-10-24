// Standalone browser fixture; no imports from the production application.
const video = document.querySelector('video');
const status = document.querySelector('#status');
let mediaSource, sourceBuffer, objectUrl, generation = 0, metrics;

window.generateFixture = async ({ count, fps, gop }) => {
  const config = { codec: 'avc1.42001f', width: 320, height: 180, bitrate: 500_000,
    framerate: fps, latencyMode: 'realtime', avc: { format: 'annexb' } };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('H.264 fixture encoder unavailable');
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d');
  const frames = []; let failure;
  const encoder = new VideoEncoder({ error: error => { failure = error; }, output(chunk) {
    const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
    frames.push({ bytes: [...bytes], type: chunk.type, timestampUs: chunk.timestamp });
  } });
  try {
    encoder.configure(config);
    for (let i = 0; i < count; i++) {
      context.fillStyle = `hsl(${i * 7 % 360} 65% 35%)`; context.fillRect(0, 0, 320, 180);
      // Eight large luma blocks identify the decoded frame, independent of text/OCR.
      for (let bit = 0; bit < 8; bit++) {
        context.fillStyle = i & (1 << bit) ? '#fff' : '#000'; context.fillRect(20 + bit * 34, 15, 26, 32);
      }
      context.fillStyle = '#fff'; context.font = '25px monospace'; context.fillText(`Frame ${i}`, 40, 110);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % gop === 0 }); frame.close();
      if (i % 8 === 7) await encoder.flush();
    }
    await encoder.flush(); if (failure) throw failure;
  } finally { encoder.close(); }
  if (frames.length !== count || frames.some((f, i) => f.timestampUs !== Math.round(i * 1e6 / fps)))
    throw new Error('Fixture encoder dropped/reordered frames');
  return { frames, config };
};

window.startPlayback = async (mime, name) => {
  generation++; video.pause(); video.removeAttribute('src'); video.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  metrics = { name, mime, supported: MediaSource.isTypeSupported(mime), decoded: [], errors: [], buffered: [], appendMs: [] };
  if (!metrics.supported) throw new Error(`Unsupported MSE format: ${mime}`);
  status.textContent = name;
  mediaSource = new MediaSource(); objectUrl = URL.createObjectURL(mediaSource); video.src = objectUrl;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MSE sourceopen timeout')), 5000);
    mediaSource.addEventListener('sourceopen', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  sourceBuffer = mediaSource.addSourceBuffer(mime);
  const thisGeneration = generation;
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const observed = (_now, metadata) => {
    if (generation !== thisGeneration) return;
    context.drawImage(video, 0, 0, 320, 180);
    let index = 0;
    for (let bit = 0; bit < 8; bit++) if (context.getImageData(33 + bit * 34, 30, 1, 1).data[0] > 128) index |= 1 << bit;
    metrics.decoded.push({ index, mediaTime: metadata.mediaTime, atMs: Date.now() });
    video.requestVideoFrameCallback(observed);
  };
  video.requestVideoFrameCallback(observed);
  video.onerror = () => metrics.errors.push({ code: video.error?.code, message: video.error?.message });
  // Don't await before the first media segment has been appended.
  void video.play().catch(error => { if (generation === thisGeneration) metrics.errors.push({ play: error.message }); });
};

window.appendSegment = async base64 => {
  // Test-driver transport only; production uses a binary platform channel.
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const started = performance.now();
  await new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); }, fail = () => { cleanup(); reject(new Error('SourceBuffer error')); };
    const cleanup = () => { clearTimeout(timer); sourceBuffer.removeEventListener('updateend', done); sourceBuffer.removeEventListener('error', fail); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('append timeout')); }, 5000);
    sourceBuffer.addEventListener('updateend', done); sourceBuffer.addEventListener('error', fail);
    try { sourceBuffer.appendBuffer(bytes); } catch (error) { cleanup(); reject(error); }
  });
  metrics.appendMs.push(performance.now() - started);
  metrics.buffered = Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]);
};

window.finishPlayback = async expectedEnd => {
  mediaSource.endOfStream();
  const started = performance.now();
  while (performance.now() - started < 15000) {
    if (metrics.errors.length) throw new Error(JSON.stringify(metrics.errors));
    if (video.ended || video.currentTime >= expectedEnd - 0.12) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const result = { ...metrics, currentTime: video.currentTime, ended: video.ended,
    width: video.videoWidth, height: video.videoHeight, quality: video.getVideoPlaybackQuality().totalVideoFrames };
  status.textContent = JSON.stringify({ ...result, decoded: `${result.decoded.length} presented frames` }, null, 2);
  return result;
};

window.disposePlayback = () => {
  generation++; video.pause(); video.removeAttribute('src'); video.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined;
};
