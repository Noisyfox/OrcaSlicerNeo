/// <reference types="node" />
import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release } from 'node:os';
import { unzipSync } from 'fflate';
import { installProfiles, createFetchProfileSource } from './profiles';
import { createClient, type OrcaModule } from '@slicer/client';
// @ts-expect-error The existing JS harness is outside the production TS project.
import { loadModuleFactory } from '../../slicer-wasm/harness/run-slice.mjs';

const requested = process.env.ORCA_SETUP_PROFILE_MODULE;
const memoryEnabled = process.env.ORCA_SETUP_PROFILE_MEMORY === '1';
it.skipIf(!requested)('measures production HTTP installation and temporary catalogue ownership', async () => {
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const root = resolve(import.meta.dirname, '../../..');
  const packages = join(root, 'packages/profile-resources/dist');
  const manifest = JSON.parse(await readFile(join(packages, 'manifest.json'), 'utf8'));
  let requests = 0, deliveredBytes = 0, fetchMs = 0;
  const failedPaths: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const relative = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname.slice(1));
      if (!relative || relative.split('/').includes('..')) throw new Error('unsafe URL');
      const bytes = await readFile(join(packages, relative));
      requests++; deliveredBytes += bytes.length;
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(bytes);
    } catch { failedPaths.push(request.url!); response.writeHead(404); response.end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const http = createFetchProfileSource(`http://127.0.0.1:${address.port}/`);
    const source = { fetch: async (path: string) => {
      const start = performance.now(); const bytes = await http.fetch(path); fetchMs += performance.now() - start; return bytes;
    } };
    const factory = await loadModuleFactory(resolve(requested!));
    const moduleStarted = performance.now();
    const module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} }) as OrcaModule;
    const moduleMs = performance.now() - moduleStarted;
    const started = performance.now(); await installProfiles(module, source); const installMs = performance.now() - started;
    expect(failedPaths).toEqual([]);
    expect(requests).toBe(manifest.packages.length + 1);
    // Outside the timed installation interval: optional vendor failures must
    // not silently turn this full-delivery measurement into a partial fixture.
    let verifiedEntries = 0;
    for (const pkg of manifest.packages) {
      const entries = unzipSync(new Uint8Array(await readFile(join(packages, pkg.path))));
      for (const [path, bytes] of Object.entries(entries)) {
        if (path.endsWith('/')) continue;
        const installed = module.FS.readFile(`${pkg.kind === 'core' ? '/system' : '/profiles'}/${path}`);
        expect(Buffer.compare(Buffer.from(installed), Buffer.from(bytes))).toBe(0);
        verifiedEntries++;
      }
    }
    function call(name: string) {
      const ptr = Number(module.ccall(name, 'number', [], []));
      try { return JSON.parse(module.UTF8ToString(ptr)); } finally { module._free(ptr); }
    }
    const allocator = () => memoryEnabled ? call('orc_take_profile_allocator_snapshot') : null;
    function rawBytes(path: string): number {
      return module.FS.readdir!(path).filter(name => name !== '.' && name !== '..').reduce((sum, name) => {
        const full = `${path}/${name}`;
        return sum + (module.FS.isDir!(module.FS.stat!(full).mode) ? rawBytes(full) : module.FS.stat!(full).size);
      }, 0);
    }
    const resourceBytes = rawBytes('/profiles') + rawBytes('/system');
    const runtime = createClient(async () => module);
    const activation = { models: [{ vendor: 'Creality', model: 'Creality Ender-3', nozzle_diameter: ['0.4'] }], filaments: ['Generic PLA @System'] };
    const initStarted = performance.now(); const initial = await runtime.init(activation); const initMs = performance.now() - initStarted;
    expect(initial.setupRequired).toBe(false);
    const before = allocator(); const samples = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      const openStarted = performance.now(); const opened = await runtime.openSetupWizardCatalogue(); const openMs = performance.now() - openStarted;
      expect(opened.ok).toBe(true); if (!opened.ok) throw new Error(opened.error);
      const during = allocator();
      const closeStarted = performance.now(); expect((await runtime.closeSetupWizardCatalogue()).ok).toBe(true); const closeMs = performance.now() - closeStarted;
      const after = allocator();
      if (memoryEnabled) {
        expect(during.complete).toBe(true); expect(after.complete).toBe(true);
        expect(during.calling_thread_live_usable_bytes).toBeGreaterThan(before.calling_thread_live_usable_bytes);
        expect(after.calling_thread_live_usable_bytes).toBeLessThan(during.calling_thread_live_usable_bytes);
      }
      samples.push({ iteration: iteration + 1, openMs, closeMs, modelCount: opened.catalogue.models.length,
        materialGroupCount: opened.catalogue.filaments.length, during, after });
    }
    if (memoryEnabled) {
      // The first full parse may warm permanent native state. Subsequent closed
      // catalogues must not retain additional malloc blocks or usable capacity.
      expect(samples[2].after.calling_thread_live_usable_bytes).toBe(samples[1].after.calling_thread_live_usable_bytes);
      expect(samples[2].after.calling_thread_live_blocks).toBe(samples[1].after.calling_thread_live_blocks);
    }
    const report = { metric: 'calling-thread live usable malloc block capacity; not requested bytes, RSS or free capacity',
      environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, node: process.version },
      module: resolve(requested!), threading: call('orc_get_threading_info'), profilingBuild: memoryEnabled, initMetric: 'typed client activation linking plus native init, not isolated C++ parsing', transport: 'production installer, real packages over loopback HTTP; public Internet not measured',
      packageCount: manifest.packages.length, verifiedEntries, requests, failedPaths, deliveredBytes, resourceBytes, moduleMs, fetchMs, installMs, installationExcludingFetchMs: installMs - fetchMs, initMs, before, samples };
    if (process.env.ORCA_SETUP_PROFILE_OUTPUT) await writeFile(process.env.ORCA_SETUP_PROFILE_OUTPUT, JSON.stringify(report, null, 2));
    process.stdout.write(`[setup-wizard-performance] ${JSON.stringify(report)}\n`);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); quiet.mockRestore(); }
}, 600_000);
