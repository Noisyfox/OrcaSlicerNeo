// Exercises the production shared player in real Chrome/Electron, without printer access.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium, _electron } from '@playwright/test';
import { avcConfiguration, createRemuxer } from './remux.mjs';

const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../../../..');
const files = new Map(), requests = [];
let mjpegConnections = 0;
const remote = createHttpServer((req, res) => {
  const item = files.get(req.url); requests.push(req.url);
  res.writeHead(item ? 200 : 404, { 'content-type': item?.mime ?? 'text/plain',
    'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' });
  if (req.url === '/camera.mjpeg' && item) {
    mjpegConnections++;
    const send = () => res.write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${item.bytes.length}\r\n\r\n`), item.bytes, Buffer.from('\r\n')]));
    send(); const timer = setInterval(send, 100);
    req.on('close', () => { clearInterval(timer); mjpegConnections--; });
  } else res.end(item?.bytes);
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
const remoteUrl = `http://127.0.0.1:${remote.address().port}`;
const vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0,
  headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob: ${remoteUrl}; img-src 'self' blob: ${remoteUrl}; connect-src 'self' ${remoteUrl}` },
}, plugins: [{ name: 'camera-fixture', configureServer(server) {
  server.middlewares.use((req, res, next) => {
    if (req.url !== '/') return next();
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><video muted playsinline width="320" height="180"></video><img hidden><pre id="status"></pre><script type="module" src="/apps/desktop/scripts/camera-prototype/player.mjs"></script>');
  });
} }] });
await vite.listen();
const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
const results = [];
try {
  for (const browser of ['chrome', 'electron']) {
    const session = browser === 'chrome' ? await chromium.launch({ headless: false,
      executablePath: process.env.ORCA_CHROME_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
    }) : await _electron.launch({ args: [join(directory, 'electron-host.cjs')], env: { ...process.env, ORCA_CAMERA_PROBE_URL: url } });
    try {
      const page = browser === 'chrome' ? await session.newPage() : await session.firstWindow();
      await page.goto(url); await page.waitForFunction(() => typeof window.generateFixture === 'function');
      await page.evaluate(async () => { window.playerModule = await import('/packages/slicer-app/src/components/device/media/playback.ts'); });
      const fixture = await page.evaluate(() => window.generateFixture({ count: 60, fps: 30, gop: 15 }));
      const config = avcConfiguration(Buffer.from(fixture.frames[0].bytes), 320, 180), segments = [];
      const muxer = await createRemuxer(config, (bytes, meta) => segments.push({ bytes, meta }));
      for (let i = 0; i < fixture.frames.length; i++) await muxer.add({ bytes: Buffer.from(fixture.frames[i].bytes), flags: fixture.frames[i].type === 'key' ? 1 : 0 }, i / 30, 1 / 30, i);
      await muxer.finish();
      files.set('/video.mp4', { mime: 'video/mp4', bytes: Buffer.concat(segments.map(s => s.bytes)) });
      files.set('/init.mp4', { mime: 'video/mp4', bytes: segments[0].bytes });
      const playlist = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="init.mp4"'];
      segments.slice(1).forEach((s, i) => { files.set(`/segment-${i}.m4s`, { mime: 'video/mp4', bytes: s.bytes }); playlist.push('#EXTINF:0.5,', `segment-${i}.m4s`); });
      playlist.push('#EXT-X-ENDLIST'); files.set('/live.m3u8', { mime: 'application/vnd.apple.mpegurl', bytes: playlist.join('\n') });
      const packets = segments.map((s, i) => ({ generation: 0, sequence: i, kind: i ? 'segment' : 'init',
        mimeType: `video/mp4; codecs="${config.codec}"`, bytes: [...s.bytes] }));
      await page.evaluate(({ packets, mime, remoteUrl }) => {
        window.packetFixture = packets; window.mime = mime; window.remoteUrl = remoteUrl;
        window.activeUrls = new Set();
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = object => { const url = create(object); window.activeUrls.add(url); return url; };
        URL.revokeObjectURL = url => { window.activeUrls.delete(url); revoke(url); };
        window.launch = (delivery, overrides = {}) => {
          window.error = null; window.states = []; window.presented = [];
          const video = document.querySelector('video');
          const observe = (_, info) => { window.presented.push(info.mediaTime); if (video.src) video.requestVideoFrameCallback(observe); };
          video.requestVideoFrameCallback(observe);
          const controller = new AbortController(); window.abortPlayer = () => controller.abort();
          window.player = window.playerModule.startMediaPlayback({
            descriptor: { ref: { printerId: 'p', routeId: 'r', id: 'm' }, configurationRevision: 'c', revision: 1,
              source: { kind: 'camera', cameraId: 'c' }, expiresAtMs: overrides.expiresAtMs ?? null,
              presentation: { kind: 'video', delivery, profile: null, durationSeconds: null, seekable: false, codecId: 'h264', live: overrides.live ?? false } },
            video, image: document.querySelector('img'), signal: controller.signal, onState: state => window.states.push(state),
            media: { readStream: (_request, { signal }) => ({ async *[Symbol.asyncIterator]() {
              try {
                for (const packet of overrides.packets ?? window.packetFixture) yield { ...packet, bytes: new Uint8Array(packet.bytes) };
                if (overrides.hold) await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
              } finally { window.streamClosed = true; }
            } }) },
          });
          window.streamClosed = false; window.player.done.catch(error => { window.error = error.message; });
        };
      }, { packets, mime: `video/mp4; codecs="${config.codec}"`, remoteUrl });
      for (const transport of ['mse-fmp4', 'progressive-http', 'hls']) {
        await page.evaluate(transport => window.launch(transport === 'mse-fmp4' ? { transport, streamId: 's', mimeType: window.mime }
          : { transport, url: `${window.remoteUrl}/${transport === 'hls' ? 'live.m3u8' : 'video.mp4'}`, mimeType: transport === 'hls' ? 'application/vnd.apple.mpegurl' : window.mime, credentials: 'same-origin' }), transport);
        await page.waitForFunction(() => window.error || window.presented.length >= 10);
        assert.equal(await page.evaluate(() => window.error), null, `${browser} ${transport}`);
        await page.evaluate(async () => { window.abortPlayer(); await window.player.done; });
        assert.equal(await page.evaluate(() => window.activeUrls.size), 0, 'Leaked video URL');
        assert.equal(await page.evaluate(() => document.querySelector('video').hasAttribute('src')), false);
        results.push({ browser, transport, passed: true });
      }
      await page.evaluate(() => window.launch({ transport: 'mse-fmp4', streamId: 's', mimeType: window.mime }, {
        packets: [...window.packetFixture, ...window.packetFixture.map(p => ({ ...p, generation: 1 }))],
      }));
      await page.waitForFunction(() => window.error || window.presented.length >= 10);
      assert.equal(await page.evaluate(() => window.error), null, 'Generation switch failed');
      await page.evaluate(async () => { window.abortPlayer(); await window.player.done; });
      assert.equal(await page.evaluate(() => window.activeUrls.size), 0);
      results.push({ browser, scenario: 'generation-switch', passed: true });
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
        const context = canvas.getContext('2d'); context.fillStyle = 'lime'; context.fillRect(0, 0, 16, 16);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
        window.jpeg = [...new Uint8Array(await blob.arrayBuffer())];
        window.launch({ transport: 'jpeg-frames', streamId: 'j', mimeType: 'image/jpeg' }, { live: true, hold: true,
          packets: Array.from({ length: 50 }, (_, sequence) => ({ generation: 0, sequence, kind: 'jpeg', bytes: window.jpeg })) });
      });
      await page.waitForFunction(() => window.error || window.states.includes('playing'));
      assert.equal(await page.evaluate(() => window.error), null);
      assert.equal(await page.evaluate(() => document.querySelector('img').naturalWidth), 16);
      await page.evaluate(async () => { window.abortPlayer(); await window.player.done; });
      assert.equal(await page.evaluate(() => window.activeUrls.size), 0, 'Leaked JPEG URL');
      results.push({ browser, transport: 'jpeg-frames', passed: true });
      await page.evaluate(() => {
        window.launch({ transport: 'jpeg-frames', streamId: 'renewed', mimeType: 'image/jpeg' }, {
          live: true, hold: true, expiresAtMs: Date.now() + 100,
          packets: [{ generation: 0, sequence: 0, kind: 'jpeg', bytes: window.jpeg }],
        });
        window.player.setExpiresAt(Date.now() + 10000);
      });
      await page.waitForFunction(() => window.states.includes('playing'));
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
      assert.equal(await page.evaluate(() => window.error), null, 'Old lease timer survived renewal');
      assert.equal(await page.evaluate(() => window.streamClosed), false, 'Renewal detached the stream');
      await page.evaluate(async () => { window.abortPlayer(); await window.player.done; });
      results.push({ browser, scenario: 'lease-renewal', passed: true });
      files.set('/camera.mjpeg' , { mime: 'multipart/x-mixed-replace; boundary=frame', bytes: Buffer.from(await page.evaluate(() => window.jpeg)) });
      await page.evaluate(() => window.launch({ transport: 'mjpeg', url: `${window.remoteUrl}/camera.mjpeg`, mimeType: 'multipart/x-mixed-replace', credentials: 'same-origin' }, { live: true }));
      await page.waitForFunction(() => window.error || (document.querySelector('img').naturalWidth === 16 && window.states.includes('playing')));
      assert.equal(await page.evaluate(() => window.error), null);
      await page.evaluate(async () => { window.abortPlayer(); await window.player.done; });
      // Native image loading must close its ongoing HTTP stream after source removal.
      for (let i = 0; i < 20 && mjpegConnections; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(mjpegConnections, 0, 'MJPEG connection survived stop');
      results.push({ browser, transport: 'mjpeg', passed: true });
      for (const fault of ['gap', 'missing-init', 'expiry', 'oversize']) {
        await page.evaluate(fault => {
          const packets = window.packetFixture.map(p => ({ ...p }));
          if (fault === 'gap') packets[1].sequence += 1;
          if (fault === 'missing-init') packets.shift();
          if (fault === 'oversize') packets[0].bytes = new Uint8Array(16 * 1024 * 1024 + 1);
          window.launch({ transport: 'mse-fmp4', streamId: 's', mimeType: window.mime }, { packets,
            ...(fault === 'expiry' ? { hold: true, expiresAtMs: Date.now() + 50 } : {}) });
        }, fault);
        await page.waitForFunction(() => window.error !== null);
        assert.equal(await page.evaluate(() => window.activeUrls.size), 0, `Leaked URL after ${fault}`);
        results.push({ browser, fault, passed: true });
      }
      console.log(`${browser}: shared MSE, direct URL, HLS, JPEG, abort/cleanup and four failure cases passed`);
    } finally { await session.close(); }
  }
  assert(requests.includes('/video.mp4') && requests.includes('/live.m3u8') && requests.includes('/segment-0.m4s'), 'Remote playback did not fetch source media');
  await mkdir(join(directory, '../../out/camera-prototype'), { recursive: true });
  await writeFile(join(directory, '../../out/camera-prototype/shared-player-report.json'), JSON.stringify({ results, requests }, null, 2));
} finally { await vite.close(); await new Promise(resolve => remote.close(resolve)); }
