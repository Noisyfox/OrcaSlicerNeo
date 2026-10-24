// AGPL-3.0. Opt-in feasibility harness, excluded from every product entrypoint.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer as createViteServer } from 'vite';
import { chromium, _electron } from '@playwright/test';
import { acquire, manifest, checksum } from '../../../../packages/bambu-native/scripts/acquire.mjs';
import { avcConfiguration, createRemuxer, normalizeTimes } from './remux.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('pnpm --filter @orca/desktop camera:prototype [--browser chrome|electron|both] [--scenario short-gop|long-gop|arrival-jitter] [--production]\n'
    + 'Requires a C++17 compiler (macOS/Linux), OpenSSL, installed Chrome, and the pinned plugin archive.\n'
    + 'Generates baseline H.264 locally; uses loopback RTSPS and a generated fixture certificate, no printer/account.\n'
    + 'Writes evidence to apps/desktop/out/camera-prototype. ORCA_CHROME_EXECUTABLE overrides Chrome.');
  process.exit(0);
}
const { values } = parseArgs({ args, options: { browser: { type: 'string', default: 'both' }, scenario: { type: 'string' }, production: { type: 'boolean', default: false } } });
const selected = values.browser;
const production = values.production;
const moduleHost = production ? await createViteServer({ configFile: false, server: { middlewareMode: true } }) : null;
const CameraMuxer = production ? (await moduleHost.ssrLoadModule(join(directory, '../../src/utility/bambu/cameraMuxer.ts'))).CameraMuxer : null;
assert(['chrome', 'electron', 'both'].includes(selected), 'Unknown --browser');
assert(['darwin', 'linux'].includes(process.platform), 'Native prototype driver currently requires macOS/Linux; Windows qualification is pending');
assert.equal(manifest.release, 'v2.2.0', 'Do not silently upgrade the prototype plugin');
const outputDirectory = resolve(directory, production ? '../../out/camera-prototype/production' : '../../out/camera-prototype');
await mkdir(outputDirectory, { recursive: true });
const networkLibrary = await acquire(); // Check the pinned archive checksum and stage its companion library.
const library = join(dirname(networkLibrary), process.platform === 'darwin' ? 'libBambuSource.dylib' : 'libBambuSource.so');
const executable = join(outputDirectory, 'read-source');
const compiler = process.env.CXX || 'c++';
const build = spawnSync(compiler, ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror',
  '-I', join(root, 'packages/slicer-wasm/cpp/src/slic3r/GUI/Printer'),
  '-I', join(root, 'packages/bambu-native/native'), join(directory, 'read-source.cpp'),
  '-o', executable, ...(process.platform === 'linux' ? ['-ldl', '-pthread'] : [])], { encoding: 'utf8' });
assert.equal(build.status, 0, build.error?.message ?? build.stderr);
const certPath = join(outputDirectory, 'fixture-cert.pem'), keyPath = join(outputDirectory, 'fixture-key.pem');
const certConfig = join(outputDirectory, 'fixture-cert.cnf');
await writeFile(certConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=neo-camera-fixture\n[ext]\nsubjectAltName=DNS:neo-camera-fixture,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-config', certConfig, '-keyout', keyPath, '-out', certPath], { encoding: 'utf8' });
assert.equal(certificate.status, 0, certificate.error?.message ?? certificate.stderr);
if (production) Object.assign(process.env, { OBN_LAN_TLS_CA_FILE: certPath, OBN_CONFIG_DIR: outputDirectory, OBN_SKIP_TLS_VERIFY: '0' });
const tls = { key: await readFile(keyPath), cert: await readFile(certPath) };

const http = createServer(async (request, response) => {
  const file = request.url === '/' ? 'player.html' : request.url === '/player.mjs' ? 'player.mjs' : null;
  if (!file) { response.writeHead(404).end(); return; }
  try {
    response.writeHead(200, { 'content-type': file.endsWith('html') ? 'text/html' : 'text/javascript',
      'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; media-src 'self' blob:; img-src 'self' blob:" });
    response.end(await readFile(join(directory, file)));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${http.address().port}`;
const scenarios = [
  { name: 'short-gop', count: 120, fps: 30, gop: 15, jitter: false },
  { name: 'long-gop', count: 210, fps: 30, gop: 90, jitter: false },
  { name: 'arrival-jitter', count: 120, fps: 30, gop: 15, jitter: true },
];
assert(!values.scenario || scenarios.some(scenario => scenario.name === values.scenario), 'Unknown --scenario');
const report = { createdAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
  plugin: { release: manifest.release, archiveSha256: manifest.artifacts[`${process.platform}-${process.arch}`].sha256,
    sourceLibrarySha256: await checksum(library) }, muxer: production ? 'mp4box@2.4.1' : 'mediabunny@1.62.1',
  provenance: 'Locally generated baseline AVC, replayed through a loopback RTSPS fixture with its own CA into the real pinned BambuSource. Not printer, printer-certificate, auth, or release qualification.',
  instrumentation: 'Independent Worker paces RTSPS and drains native samples. fMP4 reaches the page through base64 Playwright evaluation, not production IPC. Display latency includes this test-driver overhead.',
  scenarios: [] };

async function runScenario(page, browser, scenario) {
  console.log(`[${browser}] ${scenario.name}: generating ${scenario.count} frames, GOP ${scenario.gop}`);
  const fixture = await page.evaluate(options => window.generateFixture(options), scenario);
  const keys = fixture.frames.flatMap((f, i) => f.type === 'key' ? [i] : []);
  assert.deepEqual(keys, Array.from({ length: Math.ceil(scenario.count / scenario.gop) }, (_, i) => i * scenario.gop), 'Encoder changed the requested GOP');
  const original = Buffer.concat(fixture.frames.map(frame => Buffer.from(frame.bytes)));
  const prefix = join(outputDirectory, `${browser}-${scenario.name}`);
  await writeFile(`${prefix}-input.h264`, original);
  const config = avcConfiguration(Buffer.from(fixture.frames[0].bytes), fixture.config.width, fixture.config.height);
  const mime = `video/mp4; codecs="${config.codec}"`;
  await page.evaluate(({ mime, name }) => window.startPlayback(mime, name), { mime, name: `${browser} / ${scenario.name}` });
  const samples = [], segments = [], init = [], muxEvents = [];
  let pendingBytes = 0, maxPendingBytes = 0, appendFailure, appendTail = Promise.resolve(), ingestTail = Promise.resolve(), ingestFailure;
  const emitSegment = (bytes, meta) => {
    segments.push(bytes); muxEvents.push(meta); if (meta.kind === 'init') init.push(meta);
    pendingBytes += bytes.length; maxPendingBytes = Math.max(maxPendingBytes, pendingBytes);
    if (pendingBytes > 8 * 1024 * 1024) throw new Error('Prototype append queue exceeded 8 MiB');
    appendTail = appendTail.then(async () => { if (!appendFailure) await page.evaluate(data => window.appendSegment(data), bytes.toString('base64')); })
      .catch(error => { appendFailure ??= error; }).finally(() => { pendingBytes -= bytes.length; });
  };
  let muxer;
  if (production) {
    const fragments = [];
    const instance = new CameraMuxer(320, 180, packet => {
      const meta = { kind: packet.kind === 'init' ? 'init' : 'media', atMs: Date.now(), inputIndex: samples.length - 1 };
      if (meta.kind === 'media') fragments.push(meta);
      emitSegment(Buffer.from(packet.bytes), meta);
    });
    muxer = { fragments, add: async sample => instance.push({ ...sample, time100ns: BigInt(sample.time100ns) }), finish: async () => instance.finish(), cancel: async () => {} };
  } else muxer = await createRemuxer(config, emitSegment);
  const capture = new Worker(new URL('./capture-worker.mjs', import.meta.url), {
    workerData: { frames: fixture.frames, scenario, tls, executable, library, certPath, outputDirectory, ...(production ? { addonPath: join(root, 'packages/bambu-native/build/Release/bambu.node') } : {}) },
  });
  let captureResult;
  const captured = new Promise((resolve, reject) => {
    capture.once('error', reject);
    capture.on('exit', code => { if (!captureResult) reject(new Error(`Capture worker exited before completion (${code})`)); });
    capture.on('message', message => {
      if (message.type === 'complete') { captureResult = message; resolve(message); return; }
      const sample = { ...message.sample, bytes: Buffer.from(message.sample.bytes) };
      ingestTail = ingestTail.then(async () => {
        if (ingestFailure) return;
        samples.push(sample); const times = normalizeTimes(samples);
        if (production) await muxer.add(sample);
        else if (samples.length > 1) {
          const i = samples.length - 2;
          await muxer.add(samples[i], times[i], times[i + 1] - times[i], i);
        }
      }).catch(error => { ingestFailure ??= error; capture.postMessage('stop'); });
    });
  });
  let completedMux = false;
  try {
    const { code, stderr, sent, error } = await captured;
    await ingestTail; if (ingestFailure) throw ingestFailure;
    assert.equal(code, 0, `Native probe failed (${samples.length}/${scenario.count} samples, ${sent.length} sent): ${stderr}`);
    assert.equal(samples.length, scenario.count); assert.equal(sent.length, scenario.count); assert(!error, error);
    assert.deepEqual(samples.flatMap((sample, i) => sample.flags & 1 ? [i] : []), keys, 'Plugin changed keyframe boundaries');
    const times = normalizeTimes(samples), last = samples.length - 1;
    const lastDuration = times[last] - times[last - 1];
    if (!production) await muxer.add(samples[last], times[last], lastDuration, last);
    await muxer.finish(); completedMux = true;
    await appendTail; if (appendFailure) throw appendFailure;
    const playback = await page.evaluate(end => window.finishPlayback(end), times[last] + lastDuration);
    assert.equal(playback.errors.length, 0, JSON.stringify(playback.errors));
    assert.equal(playback.width, 320); assert.equal(playback.height, 180);
    assert(playback.decoded.length >= 30, 'No sustained video-frame presentation');
    const indices = playback.decoded.map(frame => frame.index);
    assert(indices.every((n, i) => n >= 0 && n < scenario.count && (!i || n >= indices[i - 1])), 'Decoded frame barcode regressed/corrupted');
    assert(indices.at(-1) >= scenario.count - 5, 'Playback did not reach the end of the generated source');
    assert(Math.abs(times.at(-1) - (scenario.count - 1) / scenario.fps) < 0.25, '100ns timeline scale/span is wrong');
    assert(playback.currentTime >= times.at(-1) - 0.15, 'MSE time did not advance with the source');
    assert.equal(init.length, 1);
    const lags = playback.decoded.map(frame => frame.atMs - sent[frame.index].atMs).sort((a, b) => a - b);
    const sourceToPlugin = samples.map((sample, i) => sample.receivedAtMs - sent[i].atMs);
    const sendIntervals = sent.slice(1).map((frame, i) => frame.atMs - sent[i].atMs);
    const result = { browser, ...scenario, mime, fixtureSha256: createHash('sha256').update(original).digest('hex'),
      pluginInfo: JSON.parse(stderr.split('\n').find(line => line.startsWith('{'))), sampleCount: samples.length, keyIndices: keys,
      timelineSpanSeconds: times.at(-1), firstFragmentDelayMs: muxer.fragments[0].atMs - samples[0].receivedAtMs,
      firstFrameDelayMs: playback.decoded[0].atMs - sent[0].atMs,
      displayedSourceLagMs: { median: lags[Math.floor(lags.length / 2)], p95: lags[Math.floor(lags.length * 0.95)] },
      pluginArrivalLagMs: { max: Math.max(...sourceToPlugin), min: Math.min(...sourceToPlugin) },
      fixtureSendIntervalMs: { min: Math.min(...sendIntervals), max: Math.max(...sendIntervals) },
      maxPendingBytes, muxEvents, playback };
    await writeFile(`${prefix}.mp4`, Buffer.concat(segments));
    await writeFile(`${prefix}-samples.json`, JSON.stringify(samples.map(({ bytes, ...sample }, i) => ({
      ...sample, size: bytes.length, source: sent[i], normalizedSeconds: times[i],
    })), null, 2));
    await writeFile(`${prefix}.json`, JSON.stringify(result, null, 2));
    await page.screenshot({ path: `${prefix}.png` });
    console.log(`[${browser}] ${scenario.name}: ${samples.length} samples, ${playback.decoded.length} displayed frames; first fragment ${result.firstFragmentDelayMs} ms, first frame ${result.firstFrameDelayMs} ms`);
    return result;
  } catch (error) {
    await writeFile(`${prefix}-failure.json`, JSON.stringify({ error: error.message, capture: captureResult,
      samples: samples.map(({ bytes, ...sample }) => ({ ...sample, size: bytes.length })), muxEvents }, null, 2));
    throw error;
  } finally {
    if (!captureResult) { capture.postMessage('stop'); await captured.catch(() => {}); }
    await ingestTail;
    if (!completedMux) await muxer.cancel().catch(() => {});
    await appendTail; await page.evaluate(() => window.disposePlayback()).catch(() => {});
  }
}

try {
  for (const browser of selected === 'both' ? ['chrome', 'electron'] : [selected]) {
    let session;
    try {
      let page;
      if (browser === 'chrome') {
        session = await chromium.launch({ headless: false,
          executablePath: process.env.ORCA_CHROME_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
          args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
        page = await session.newPage(); await page.goto(url);
      } else {
        session = await _electron.launch({ args: [join(directory, 'electron-host.cjs')], env: { ...process.env, ORCA_CAMERA_PROBE_URL: url } });
        page = await session.firstWindow();
      }
      await page.waitForFunction(() => typeof window.generateFixture === 'function');
      report[`${browser}Version`] = browser === 'chrome' ? session.version() : await session.evaluate(() => process.versions);
      for (const scenario of scenarios.filter(scenario => !values.scenario || scenario.name === values.scenario)) {
        report.scenarios.push(await runScenario(page, browser, scenario));
        await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
      }
    } finally { await session?.close(); }
  }
  console.log(`Evidence: ${join(outputDirectory, 'report.json')}`);
} finally { await new Promise(resolve => http.close(resolve)); await moduleHost?.close(); }
