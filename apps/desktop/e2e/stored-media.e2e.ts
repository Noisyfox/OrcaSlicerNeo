import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny';

test('real stored-video cache starts before EOF, decodes and seeks through utility ports, and navigation cleans up', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'neo-stored-media-'));
  const bundled = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
    lib: { entry: resolve('e2e/stored-media-player.ts'), name: 'StoredMediaProbe', formats: ['iife'] }, rollupOptions: { output: { inlineDynamicImports: true } } } });
  const script = (Array.isArray(bundled) ? bundled[0] : bundled) as { output: { type: string; code?: string }[] };
  const content = script.output.find(entry => entry.type === 'chunk')!.code!;
  const app = await _electron.launch({ args: [resolve('out/main/stored-media-smoke.js')], env: { ...process.env, ORCA_BAMBU_SMOKE_DIRECTORY: directory } });
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => !!(window as any).orca);
    const encoded = await page.evaluate(async () => {
      const config: VideoEncoderConfig = { codec: 'avc1.42001f', width: 320, height: 180, bitrate: 300_000, framerate: 30, latencyMode: 'realtime', avc: { format: 'avc' } };
      if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('AVC encoder is unavailable');
      const packets: { bytes: number[]; type: EncodedVideoChunkType; timestamp: number; duration: number }[] = [];
      let description: number[] = [], codec = '', failure: unknown;
      const encoder = new VideoEncoder({ error: e => { failure = e; }, output(chunk, metadata) {
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
        packets.push({ bytes: [...bytes], type: chunk.type, timestamp: chunk.timestamp / 1e6, duration: 1 / 30 });
        if (metadata?.decoderConfig?.description) { description = [...new Uint8Array(metadata.decoderConfig.description as ArrayBuffer)]; codec = metadata.decoderConfig.codec; }
      } });
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; const context = canvas.getContext('2d')!;
      encoder.configure(config);
      for (let i = 0; i < 120; i++) {
        context.fillStyle = i < 60 ? '#00ff00' : '#ff0000'; context.fillRect(0, 0, 320, 180);
        const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / 30), duration: Math.round(1e6 / 30) });
        encoder.encode(frame, { keyFrame: i % 30 === 0 }); frame.close(); if (i % 15 === 14) await encoder.flush();
      }
      await encoder.flush(); encoder.close(); if (failure) throw failure;
      return { packets, description, codec };
    });
    const target = new BufferTarget(), source = new EncodedVideoPacketSource('avc');
    const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'in-memory' }) }); output.addVideoTrack(source); await output.start();
    for (let i = 0; i < encoded.packets.length; i++) { const packet = encoded.packets[i]; await source.add(new EncodedPacket(new Uint8Array(packet.bytes), packet.type, packet.timestamp, packet.duration, i),
      i ? undefined : { decoderConfig: { codec: encoded.codec, codedWidth: 320, codedHeight: 180, description: new Uint8Array(encoded.description) } }); }
    source.close(); await output.finalize(); await writeFile(join(directory, 'fixture.mp4'), new Uint8Array(target.buffer!));
    await page.addScriptTag({ content });
    await page.evaluate(async () => {
      const state = window as any, media = state.StoredMediaProbe.bambuMedia(state.orca.bambu);
      const file = { printerId: 'bambu:fixture', routeId: 'bambu:fixture:agent', configurationRevision: 'r1', storageId: 'sdcard',
        fileId: 'bambu-file:' + btoa(JSON.stringify({ collection: 'video', name: 'fixture.mp4', path: '/fixture.mp4' })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') };
      state.request = { target: { printerId: file.printerId, routeId: file.routeId }, requestId: 'first', source: { kind: 'file-preview', target: file, previewId: 'video' }, client: { video: [{ transport: 'mse-fmp4', codecIds: ['h264'] }], imageMimeTypes: [], contentFormats: [] } };
      const result = await media.open(state.request); if (!result.ok) throw new Error(result.error.message);
      state.media = media; state.descriptor = result.value; state.errors = [];
      state.player = state.StoredMediaProbe.startStoredPlayback(result.value, media, document.querySelector('video'), (message: string) => state.errors.push(message));
    });
    await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.2);
    expect(await readFile(join(directory, 'complete'), 'utf8').catch(() => '')).toBe('');
    expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
    await writeFile(join(directory, 'continue'), 'continue');
    await expect.poll(() => readFile(join(directory, 'complete'), 'utf8').catch(() => '')).toContain('complete');
    await page.evaluate(async () => {
      const state = window as any, status = await state.orca.bambu.media('get', state.descriptor.ref);
      state.player.setRanges(status.value.descriptor.presentation.cachedRanges); if (!state.player.seek(2.5)) throw new Error('Seek rejected');
    });
    await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(2.5);
    await expect.poll(() => page.locator('video').evaluate(element => {
      const video = element as HTMLVideoElement; const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(video, 0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[0];
    })).toBeGreaterThan(200);
    expect(await page.evaluate(() => (window as any).errors)).toEqual([]);
    await page.evaluate(async () => { const state = window as any; await state.player.stop(); await state.media.close(state.descriptor.ref); });
    const caches = async () => { const roots = await readdir(join(directory, 'cache')); return (await Promise.all(roots.map(root => readdir(join(directory, 'cache', root))))).flat(); };
    await expect.poll(caches).toEqual([]);
    await rm(join(directory, 'continue'));
    await page.evaluate(async () => { const state = window as any; const result = await state.media.open({ ...state.request, requestId: 'second' }); if (!result.ok) throw new Error(result.error.message); });
    await page.goto('data:text/html,<title>Left storage</title>');
    await expect.poll(caches).toEqual([]);
    expect((await readFile(join(directory, 'returned'), 'utf8')).trim().split('\n')).toHaveLength(2);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
