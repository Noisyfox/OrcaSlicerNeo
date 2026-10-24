// Keep fixture pacing and native stdout drainage independent of browser-driver work.
import { parentPort, workerData } from 'node:worker_threads';
import { loadBambuCamera } from '../../../../packages/bambu-native/dist/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { startRtspFixture } from './rtsp-fixture.mjs';

const { frames, scenario, tls, executable, library, certPath, outputDirectory, addonPath } = workerData;
const rtsp = await startRtspFixture(frames, { ...scenario, tls });

if (addonPath) {
  process.env.OBN_LAN_TLS_CA_FILE = certPath; process.env.OBN_CONFIG_DIR = outputDirectory; process.env.OBN_SKIP_TLS_VERIFY = '0';
  const camera = loadBambuCamera(addonPath, library, rtsp.url);
  let stopped = false, count = 0, metadata, error;
  parentPort.on('message', message => { if (message === 'stop') stopped = true; });
  const deadline = Date.now() + 30000;
  try {
    while (!stopped && count < scenario.count && Date.now() < deadline) {
      const result = camera.poll();
      if (result.ready) metadata = { width: result.width, height: result.height, advisoryFps: null };
      for (const sample of result.samples) {
        const bytes = Uint8Array.from(sample.bytes);
        parentPort.postMessage({ type: 'sample', sample: { flags: sample.flags, time100ns: sample.time100ns.toString(), receivedAtMs: Date.now(), bytes } }, [bytes.buffer]); count++;
      }
      await delay(2);
    }
    if (count !== scenario.count) throw new Error('Native capture incomplete');
  } catch (failure) { error = failure.message; }
  finally { await camera.close(); await rtsp.close(); }
  parentPort.postMessage({ type: 'complete', code: error ? 1 : 0, stderr: JSON.stringify(metadata), sent: rtsp.sent, error });
  parentPort.close();
} else {
const native = spawn(executable, [library, rtsp.url, String(scenario.count)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, OBN_LAN_TLS_CA_FILE: certPath, OBN_CONFIG_DIR: outputDirectory, OBN_SKIP_TLS_VERIFY: '0' },
});
let pending = Buffer.alloc(0), stderr = '', failure;
native.stderr.on('data', bytes => { stderr += bytes; });
native.stdout.on('data', bytes => {
  pending = Buffer.concat([pending, bytes]);
  while (pending.length >= 24) {
    const length = pending.readUInt32LE(0);
    if (length > 4 * 1024 * 1024) { failure = 'Oversized native sample'; native.kill('SIGKILL'); break; }
    if (pending.length < 24 + length) break;
    const bytes = Uint8Array.from(pending.subarray(24, 24 + length));
    parentPort.postMessage({ type: 'sample', sample: { flags: pending.readUInt32LE(4), time100ns: pending.readBigUInt64LE(8).toString(),
      readUs: Number(pending.readBigUInt64LE(16)), receivedAtMs: Date.now(), bytes } }, [bytes.buffer]);
    pending = pending.subarray(24 + length);
  }
});
const timeout = setTimeout(() => { failure = 'Native capture timeout'; native.kill('SIGKILL'); }, 35000);
parentPort.on('message', message => { if (message === 'stop') native.kill('SIGKILL'); });
try {
  const code = await new Promise((resolve, reject) => { native.once('error', reject); native.once('close', resolve); });
  parentPort.postMessage({ type: 'complete', code, stderr, sent: rtsp.sent,
    error: failure ?? rtsp.failure?.message ?? (pending.length ? 'Truncated native sample' : null) });
} finally {
  clearTimeout(timeout); if (native.exitCode === null && native.signalCode === null) native.kill('SIGKILL');
  await rtsp.close(); parentPort.close();
}

}
