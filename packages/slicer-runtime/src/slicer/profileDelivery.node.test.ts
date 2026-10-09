import { test, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorkerClient, type WorkerMessage } from '@slicer/client';

/** Real desktop Node Worker output; test-only read instrumentation stays outside host code. */
test.skipIf(process.env.ORCA_PROFILE_DELIVERY_NODE !== '1').each([false, true])('real Node host reads startup subset, fills catalogue once and preserves project (firstUse=%s)', async firstUse => {
  const root = resolve('../..');
  const modulePath = join(root, 'apps/desktop/out/main/slicer-worker.js');
  expect(await readFile(modulePath, 'utf8')).toContain('const useMock = false');
  const manifest = JSON.parse(await readFile(join(root, 'apps/desktop/out/renderer/profiles/manifest.json'), 'utf8')) as { packages: { id: string; path: string }[] };
  const directory = await mkdtemp(join(tmpdir(), 'orca-delivery-node-'));
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const fs = require('node:fs/promises');
    const original = fs.readFile;
    fs.readFile = async function(path, ...args) {
      const result = await original.call(this, path, ...args);
      const normalized = String(path).replaceAll('\\\\', '/');
      const relative = normalized.split('/profiles/')[1];
      if (relative) parentPort.postMessage({ testProfileRead: relative });
      return result;
    };
    require('node:module').syncBuiltinESMExports();
    require(${JSON.stringify(modulePath)});
  `, { eval: true, workerData: { temporaryDirectory: directory } });
  const reads: string[] = [];
  const runtime = createWorkerClient({ post: message => worker.postMessage(message), onMessage: listener => {
    worker.on('message', (message: WorkerMessage | { testProfileRead: string }) => {
      if ('testProfileRead' in message) reads.push(message.testProfileRead); else listener(message);
    });
    worker.on('error', error => listener({ type: 'fatal', error: String(error) }));
  } });
  try {
    const activation = { models: [{ vendor: 'Creality', model: 'Creality Ender-3', nozzle_diameter: ['0.4'] }], filaments: ['Generic PLA @System'] };
    expect(await runtime.init(firstUse ? null : activation)).toMatchObject({ ok: true, setupRequired: firstUse });
    const vendors = firstUse ? ['core', 'OrcaFilamentLibrary'] : ['core', 'Creality', 'OrcaFilamentLibrary'];
    expect(reads).toEqual(['manifest.json', ...manifest.packages.filter(pkg => vendors.includes(pkg.id)).map(pkg => pkg.path)]);
    const snapshot = async () => ({ profiles: await runtime.getProfileSnapshot(), history: await runtime.getHistoryStatus(),
      filaments: await runtime.getFilamentSessionSnapshot(), model: await runtime.getModelStructure() });
    const before = await snapshot();
    const opened = await runtime.openSetupWizardCatalogue(); expect(opened.ok).toBe(true);
    expect([...reads].sort()).toEqual(['manifest.json', ...manifest.packages.map(pkg => pkg.path)].sort());
    await runtime.closeSetupWizardCatalogue(); expect(await snapshot()).toEqual(before);
    expect(await runtime.openSetupWizardCatalogue()).toEqual(opened); await runtime.closeSetupWizardCatalogue();
    expect(reads).toHaveLength(manifest.packages.length + 1); expect(await snapshot()).toEqual(before);
  } finally { await worker.terminate(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
