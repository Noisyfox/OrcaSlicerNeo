// Real production module, typed client and native history. Geometry generation
// and measurements are fixtures only, never an application Boolean backend.
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createNodeProfileSource, fixtureProfileOptions, installProfilePackages } from './profile-installer.mjs';
import { meshBooleanSphereFixture } from './mesh-boolean-fixtures.mjs';

function measure(mesh) {
  const parents = Uint32Array.from({ length: mesh.vertexCount }, (_, index) => index);
  const find = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
  let volume = 0;
  const { positions: p, indices } = mesh;
  for (let i = 0; i < indices.length; i += 3) {
    const [a,b,c] = [indices[i],indices[i+1],indices[i+2]];
    const root = find(a); parents[find(b)] = root; parents[find(c)] = root;
    const [ai,bi,ci] = [a*3,b*3,c*3];
    volume += (p[ai]*(p[bi+1]*p[ci+2]-p[bi+2]*p[ci+1]) + p[ai+1]*(p[bi+2]*p[ci]-p[bi]*p[ci+2]) +
      p[ai+2]*(p[bi]*p[ci+1]-p[bi+1]*p[ci])) / 6;
  }
  return { vertices: mesh.vertexCount, triangles: indices.length / 3,
    indexedComponents: new Set(Array.from(indices, find)).size, volume: Math.abs(volume) };
}

async function runCases() {
  const { createClient } = await import(workerData.client);
  const { default: factory } = await import(pathToFileURL(workerData.module).href);
  const module = await factory({ noInitialRun: true, locateFile: name => resolve(dirname(workerData.module), name),
    print: () => {}, printErr: () => {} });
  await installProfilePackages(module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
  const pointer = Number(module.ccall('orc_init', 'number', ['string'], [fixtureProfileOptions(module)]));
  try { assert.equal(JSON.parse(module.UTF8ToString(pointer)).ok, true); } finally { module._free(pointer); }
  const client = createClient(async () => module);
  const context = { selection: { mode: 'instance', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: null, gizmo: null, nativeScopedConfig: {} };
  const expected = (() => {
    const r = 20, d = Math.hypot(15,10,5), full = 4*Math.PI*r**3/3;
    const intersection = Math.PI*(4*r+d)*(2*r-d)**2/12;
    return { union: 2*full-intersection, difference: full-intersection, intersection };
  })();
  for (const level of workerData.levels) {
    const fixture = meshBooleanSphereFixture(level);
    for (const operation of workerData.operations) {
      assert.equal((await client.clearModel()).ok, true);
      assert.equal((await client.resetHistory(context)).disabled, false);
      assert.equal((await client.resetPlateSession()).ok, true);
      assert.equal((await client.addModel(fixture.bytes, 'stl', `Sphere ${level}`)).ok, true);
      const object = (await client.getModelStructure()).objects[0], a = object.volumes[0].id;
      const added = await client.addVolume({ objectId: object.id, instanceId: object.instances[0].id,
        volumeType: 'model_part', ext: 'stl', name: 'Tool sphere' }, fixture.bytes);
      assert.equal(added.ok, true);
      const b = (await client.getModelMesh()).objects.find(mesh => mesh.volumeId === added.volumeId);
      const trs = { offset: [15,10,5], rotation: [0,0,0], scale: [1,1,1], mirror: [1,1,1] };
      assert.equal((await client.setModelTransform(b.objectIdx,b.volumeIdx,b.instanceIdx,b.instanceTransform,trs)).ok, true);
      await client.recomputePlateMembership();
      await client.resetHistory(context);
      const id = `${level}:${operation}`, heapBefore = module.HEAPU8.buffer.byteLength;
      parentPort.postMessage({ phase: 'start', id });
      const start = performance.now();
      let result;
      const committed = await client.runProjectHistoryTransaction('Mesh Boolean scale', 'project', context, async () => {
        result = await client.meshBoolean({ entry: 'gizmo', objectId: object.id, instanceId: object.instances[0].id,
          sourceVolumeId: a, toolVolumeId: added.volumeId, operation, deleteInput: true, keepPainting: false });
        assert.equal(result.ok && result.changed, true, JSON.stringify(result));
        return result;
      }, () => ({ ...context, selection: { mode: 'part', objectIds: [object.id], partIds: [result.volumeId], instanceIds: [object.instances[0].id] } }));
      const nativeHistoryElapsedMs = performance.now() - start;
      assert.equal(committed.status.undoEntries.length, 1);
      const output = (await client.getModelMesh()).objects.find(mesh => mesh.volumeId === result.volumeId);
      const stats = measure(output);
      const relativeVolumeError = Math.abs(stats.volume - expected[operation]) / expected[operation];
      assert.equal(stats.indexedComponents, 1, `Disconnected ${id}: ${JSON.stringify(stats)}`);
      assert.ok(relativeVolumeError < .01, `Sphere-lens volume error ${id}: ${relativeVolumeError}`);
      const heapAfter = module.HEAPU8.buffer.byteLength;
      parentPort.postMessage({ phase: 'measurement', id, level, operation, inputTrianglesPerOperand: fixture.triangles,
        inputTrianglesTotal: 2*fixture.triangles, output: stats, nativeHistoryElapsedMs, relativeVolumeError,
        wasmHeapCapacityBefore: heapBefore, wasmHeapCapacityHighWaterSinceStartup: heapAfter,
        workerJsHeapAfter: process.memoryUsage().heapUsed,
        shared: typeof SharedArrayBuffer !== 'undefined' && module.HEAPU8.buffer instanceof SharedArrayBuffer });
    }
  }
  parentPort.postMessage({ phase: 'done' });
}

if (!isMainThread && workerData?.meshBooleanScale === true) {
  try { await runCases(); } catch (error) { parentPort.postMessage({ phase: 'failure', error: error.stack ?? String(error) }); }
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i+1];
  if (!options.module) throw new Error('Usage: node harness/mesh-boolean-scale.mjs --module <production module.js> [--levels 4,5,6] [--operations union,difference,intersection] [--report result.json]');
  const levels = (options.levels ?? '4,5,6').split(',').map(Number);
  const operations = (options.operations ?? 'union,difference,intersection').split(',');
  assert.ok(levels.every(value => Number.isInteger(value) && value >= 4 && value <= 8), 'Sphere-lens oracle requires fixture subdivision levels 4..8');
  assert.ok(operations.every(value => ['union','difference','intersection'].includes(value)));
  const temporary = await mkdtemp(join(tmpdir(), 'orca-boolean-scale-')), bundle = join(temporary, 'client.mjs');
  const require = createRequire(new URL('../../slicer-app/package.json', import.meta.url));
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
  await build({ stdin: { contents: `export { createClient } from ${JSON.stringify(resolve(import.meta.dirname, '../src/client/client.ts'))};`,
    resolveDir: temporary, loader: 'ts' }, outfile: bundle, bundle: true, format: 'esm', platform: 'node',
    define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
  const artifact = resolve(options.module), samples = [];
  const worker = new Worker(new URL(import.meta.url), { workerData: { meshBooleanScale: true, module: artifact, client: pathToFileURL(bundle).href, levels, operations } });
  let current = null, casePeak = 0, processPeak = process.memoryUsage().rss;
  const sampleRss = () => { const rss = process.memoryUsage().rss; processPeak = Math.max(processPeak,rss); if (current) casePeak = Math.max(casePeak,rss); };
  const interval = setInterval(sampleRss,25);
  let failure;
  try {
    await new Promise((resolveDone,reject) => {
      worker.on('message', message => {
        if (message.phase === 'start') { current = message.id; casePeak = process.memoryUsage().rss; }
        if (message.phase === 'measurement') {
          sampleRss();
          const value = { ...message, hostProcessRssHighWaterSampled: casePeak };
          delete value.phase; samples.push(value); current = null;
          console.log(JSON.stringify(value));
        }
        if (message.phase === 'done') resolveDone();
        if (message.phase === 'failure') reject(new Error(message.error));
      });
      worker.once('error',reject);
      worker.once('exit',code => reject(new Error(`Scale Worker exited before completion (${code})`)));
    });
  } catch (error) { failure = error; }
  finally { clearInterval(interval); await worker.terminate(); }
  const report = { passed: !failure, ...(failure ? { error: failure.stack ?? String(failure) } : {}), artifact, wasmSha256: createHash('sha256').update(await readFile(artifact.replace(/\.(?:m|c)?js$/,'.wasm'))).digest('hex'),
    node: process.version, host: { platform: process.platform, arch: process.arch, logicalCores: cpus().length },
    processRssHighWaterSampled: processPeak, rssSamplingIntervalMs: 25,
    scope: 'Real typed native command plus history commit, followed by native mesh read. First case includes lazy compilation. No renderer/GPU or painting-preservation timing.',
    memoryMeaning: 'WASM capacity cannot shrink: final capacity is its high-water since module startup, not live allocator usage. RSS is sampled for this entire Node process, including owner and pthread Workers.', samples };
  if (options.report) { await mkdir(dirname(resolve(options.report)),{ recursive: true }); await writeFile(resolve(options.report),JSON.stringify(report,null,2)+'\n'); }
  if (failure) throw failure;
  console.log(JSON.stringify({ passed: true, cases: samples.length, report: options.report ?? null, processRssHighWaterSampled: processPeak }));
}
